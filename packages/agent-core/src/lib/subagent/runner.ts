import { randomUUID } from 'node:crypto';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import {
  BRIEF_USER_REQUEST_MAX_CHARS,
  CHILD_RUN,
  childAllocation,
  emptyRunUsage,
  totalRunUsage,
  lastRunFrom,
  type ContextBudget,
  type LedgerAppendMeta,
  type LedgerRecord,
  type ModelRole,
  type RunUsage,
  type SubagentReport,
  type SubagentResult,
  type SubagentSpec,
  type SubagentReportStatus,
  type SubagentStatus,
  type TaskFinding,
  type ThreadLastRun,
  type TraceEvent,
} from '@agent/agent-models';

import type {
  ModelCallFn,
  SubagentParent,
  SubagentSpawner,
} from '../loop/types';
import { estimatePromptTokens } from '../model/estimate-prompt-tokens';
import type { RunManager } from '../run/run-manager';
import { createToolRegistry, listTools } from '../tools/registry';
import {
  buildAdvisorQuestion,
  buildBrief,
  buildSubagentPrompt,
  childSkills,
  createReportTool,
  renderDigest,
  mergeReportFindings,
  renderReport,
} from './prompt';
import { earnedThoroughness, normalizeScopePaths, overlappingPath, usageDelta } from '../policy';
import { getSubagentProfile } from './profiles';
import {
  CHILD_STRIPPED_TOOLS,
  MAX_CONCURRENT_SUBAGENTS,
  type SubagentProfile,
} from './types';

/** Persistence and model wiring the host supplies. Core opens no disk or network. */
export type SubagentHost = {
  createThread(input: {
    title: string;
    model: string;
    workspaceRoot?: string;
    parentThreadId: string;
    parentRunId: string;
    /** Recorded so `resume` can require the same profile. */
    profile: string;
  }): Promise<{ id: string }>;
  /** Parent thread and profile of a child thread, for validating `resume`. */
  childInfo(
    threadId: string,
  ): { parentThreadId?: string; profile?: string } | undefined;
  /** Non-system history of a child thread, as chat messages (for `resume`). */
  loadMessages(threadId: string): Promise<ChatCompletionMessageParam[]>;
  append(input: {
    threadId: string;
    runId: string;
    record: LedgerRecord;
    meta?: LedgerAppendMeta;
  }): Promise<void>;
  putBlob(threadId: string, text: string): Promise<string>;
  readBlob(
    threadId: string,
    sha256: string,
    offset?: number,
    length?: number,
  ): Promise<string>;
  writeLastRun(threadId: string, lastRun: ThreadLastRun): Promise<void>;
  /** Model id for a role; `main` is the parent's model. */
  modelFor(role: ModelRole, parentModel: string): string;
  /**
   * Call function with that model's own options (temperature, window), with
   * thinking resolved from the profile against that model's own values.
   */
  modelCall(model: string, thinking: SubagentProfile['thinking']): Promise<ModelCallFn>;
  /** Context budget for a model at the default window. */
  contextBudget(model: string): Promise<ContextBudget>;
  agentsMd(workspaceRoot: string): Promise<string>;
  trace(threadId: string): ((event: TraceEvent) => void) | undefined;
};

const PROGRESS_INTERVAL_MS = 1_000;

/** Last text of a child that ended without `report`, used as its summary. */
const FALLBACK_SUMMARY_MAX_CHARS = 1_500;

/**
 * What a child's work amounts to, from evidence: stopped early (limit,
 * cancel, error), no report at all, reported partial, or open questions
 * left → partial; reported blocked → blocked; else done.
 */
export function reportStatusOf(
  status: SubagentStatus,
  limitReason: string | undefined,
  report: SubagentReport | undefined,
): SubagentReportStatus {
  if (status !== 'completed' || limitReason || !report) return 'partial';
  if (report.status === 'blocked') return 'blocked';
  if (report.status === 'partial' || (report.openQuestions?.length ?? 0) > 0) return 'partial';
  return 'done';
}

function clampTitle(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, 7);
  return words.length ? words.join(' ') : 'Sub-agent';
}

/** Bounded wait queue: at most `max` children run at once per parent run. */
class Slots {
  private active = 0;
  private queue: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async acquire(signal: AbortSignal): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        this.active += 1;
        resolve();
      };
      // A cancelled waiter leaves the queue; otherwise release() would hand
      // it a slot nobody gives back and the run's Slots never goes idle.
      const onAbort = () => {
        const index = this.queue.indexOf(grant);
        if (index >= 0) this.queue.splice(index, 1);
        reject(new Error('Run cancelled'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(grant);
    });
  }
  release(): void {
    this.active -= 1;
    this.queue.shift()?.();
  }
  get idle(): boolean {
    return this.active === 0 && this.queue.length === 0;
  }
}

/**
 * Sub-agent runner. One per host process; the loop calls it with the
 * parent's state. Enforces the child contract: capabilities ⊆ parent,
 * no nesting, budget carved from the parent, cancel with the parent,
 * structured report, bounded digest, usage charged back.
 */
export function createSubagentRunner(deps: {
  runManager: RunManager;
  host: SubagentHost;
  maxConcurrent?: number;
}): SubagentSpawner {
  const slots = new Map<string, Slots>();
  const inflight = new Map<string, Promise<SubagentResult>>();
  // Paths each running child covers, per parent run (objective → paths).
  const activePaths = new Map<string, Map<string, string[]>>();
  // Prompt tokens promised to running children, per parent run. A child's
  // cap comes out of what is left after these, so parallel children can
  // never be promised more than the parent has.
  const reserved = new Map<string, number>();

  function failure(
    spec: SubagentSpec,
    status: SubagentStatus,
    message: string,
    subThreadId = '',
  ): SubagentResult {
    return {
      subRunId: randomUUID(),
      subThreadId,
      profile: spec.profile,
      status,
      digest: renderDigest(message, undefined),
      iterations: 0,
      toolCalls: 0,
      usage: emptyRunUsage(),
    };
  }

  async function run(
    spec: SubagentSpec,
    parent: SubagentParent,
    profile: SubagentProfile,
  ): Promise<SubagentResult> {
    const { host, runManager } = deps;
    const model = host.modelFor(profile.modelRole, parent.model);
    const subRunId = randomUUID();

    // Capabilities: wanted ∩ parent registry − always-stripped (+ report).
    const stripped = new Set<string>(CHILD_STRIPPED_TOOLS);
    const allowed = profile.tools.filter(
      (name) => parent.toolNames.includes(name) && !stripped.has(name),
    );
    let report: SubagentReport | undefined;
    const reportTool = profile.report
      ? [
          createReportTool((value) => {
            report = value;
          }),
        ]
      : [];
    const tools = createToolRegistry(
      [...listTools(), ...reportTool],
      [...allowed, ...reportTool.map((tool) => tool.definition.function.name)],
      parent.posture,
    );

    // The child's limits: the brief's effort (or the profile's default) as
    // a budget, under the profile ceiling and a share of what the parent has
    // left. Refuse before creating a thread when nothing is left to share.
    const earned = earnedThoroughness(spec.thoroughness, profile.defaultThoroughness, Boolean(spec.resume));
    const thoroughness = earned.thoroughness;
    if (earned.capped) {
      parent.trace?.({
        type: 'policy_decision',
        runId: parent.runId,
        iteration: parent.iteration?.() ?? 0,
        kind: 'delegation',
        ids: ['effort_capped:thorough'],
        reason: 'thorough is granted only when resuming a sub-agent',
        inputs: { requested: spec.thoroughness ?? profile.defaultThoroughness ?? 'none', granted: 'medium' },
      });
    }
    const allocate = () =>
      childAllocation({
        profile: profile.limits,
        ...(thoroughness ? { thoroughness } : {}),
        ...(parent.remainingPromptTokens !== undefined
          ? { parentRemaining: parent.remainingPromptTokens }
          : {}),
        promised: reserved.get(parent.runId) ?? 0,
      });
    if (!allocate()) {
      return failure(spec, 'error', 'No run budget left for a sub-agent. Finish the work yourself.');
    }

    const paused = parent.capacity?.pauseReason();
    if (paused) {
      return failure(spec, 'error', `Account usage limit: ${paused}. Do not delegate now.`);
    }

    // An advisor re-sends the parent's whole conversation. When that alone is
    // bigger than its share, the child could only spend its cap on a forced
    // final answer, so refuse before creating a thread.
    if (profile.context === 'fork' && parent.remainingPromptTokens !== undefined) {
      const available = allocate()?.maxPromptTokens ?? 0;
      const needed = estimatePromptTokens(parent.forkMessages());
      if (needed > available) {
        return failure(
          spec,
          'error',
          `Not enough run budget for advisor: this conversation is ~${needed} tokens and its share is ${available}. Decide yourself.`,
        );
      }
    }

    let threadId: string;
    let history: ChatCompletionMessageParam[] = [];
    if (spec.resume) {
      const info = host.childInfo(spec.resume);
      if (info?.parentThreadId !== parent.threadId) {
        return failure(
          spec,
          'error',
          `Cannot resume ${spec.resume}: not a sub-agent of this thread.`,
        );
      }
      if (profile.context === 'fork') {
        return failure(
          spec,
          'error',
          'advisor cannot be resumed: it reads this conversation fresh each time. Ask a new question.',
        );
      }
      if (info.profile && info.profile !== profile.name) {
        return failure(
          spec,
          'error',
          `Cannot resume ${spec.resume} as ${profile.name}: it was started as ${info.profile}.`,
        );
      }
      threadId = spec.resume;
      history = await host.loadMessages(threadId);
    } else {
      threadId = (
        await host.createThread({
          title: clampTitle(spec.objective),
          model,
          ...(parent.workspaceRoot
            ? { workspaceRoot: parent.workspaceRoot }
            : {}),
          parentThreadId: parent.threadId,
          parentRunId: parent.runId,
          profile: profile.name,
        })
      ).id;
    }

    const parentMessages = parent.forkMessages();
    let messages: ChatCompletionMessageParam[];
    let contextBudget: ContextBudget;
    if (profile.context === 'fork') {
      // Same prefix as the parent, so a caching provider reuses it.
      messages = [
        ...parentMessages,
        { role: 'user', content: buildAdvisorQuestion(spec) },
      ];
      contextBudget = parent.contextBudget;
    } else {
      const agentsMd =
        profile.rules && parent.workspaceRoot
          ? await host.agentsMd(parent.workspaceRoot)
          : '';
      const bound = childSkills([
        ...profile.skills,
        ...(profile.inheritPickedSkills ? (parent.pinnedSkills ?? []) : []),
      ]);
      const childTrace = host.trace(threadId);
      for (const skill of bound) {
        childTrace?.({
          type: 'skill_loaded',
          runId: subRunId,
          name: skill.name,
          tokens: Math.ceil(skill.body.length / 4),
          source: profile.skills.includes(skill.name) ? 'profile' : 'pick',
        });
      }
      const system = buildSubagentPrompt({
        profile,
        toolNames: [...tools.byName.keys()],
        ...(parent.workspaceRoot
          ? { workspaceRoot: parent.workspaceRoot }
          : {}),
        agentsMd,
        skills: bound,
      });
      // The parent hands over the user's own words. Its prompt also holds
      // user-role text the harness wrote (the context header, notes, the
      // task record), so the request is never read back out of the messages.
      const userRequest = profile.context === 'diff' ? parent.userRequest : undefined;
      // A request past the brief's limit is stored whole on the child's
      // thread, so the cut in the brief can name the full text.
      const fullRequestSha =
        userRequest && userRequest.length > BRIEF_USER_REQUEST_MAX_CHARS && tools.byName.has('recall')
          ? await host.putBlob(threadId, userRequest)
          : undefined;
      const brief = buildBrief(thoroughness ? { ...spec, thoroughness } : spec, userRequest, fullRequestSha);
      messages = [
        { role: 'system', content: system },
        ...history,
        { role: 'user', content: brief },
      ];
      contextBudget = await host.contextBudget(model);
    }

    const promised = reserved.get(parent.runId) ?? 0;
    const allocation = allocate();
    if (!allocation) {
      return failure(
        spec,
        'error',
        'No run budget left for a sub-agent. Finish the work yourself.',
        threadId,
      );
    }
    // Narrowed copy for the closure below.
    const granted = allocation;
    const carve = granted.maxPromptTokens;
    host.trace(threadId)?.({
      type: 'child_budget',
      runId: subRunId,
      parentRunId: parent.runId,
      profile: profile.name,
      ...(thoroughness ? { thoroughness } : {}),
      ...allocation,
      ...(parent.remainingPromptTokens !== undefined
        ? { parentRemaining: Math.max(0, parent.remainingPromptTokens - promised) }
        : {}),
    });
    reserved.set(parent.runId, promised + carve);
    try {
      return await startAndSettle(carve);
    } finally {
      // The parent is charged actual spend; release the promise either way.
      const left = (reserved.get(parent.runId) ?? carve) - carve;
      if (left > 0) reserved.set(parent.runId, left);
      else reserved.delete(parent.runId);
    }

    async function startAndSettle(carve: number): Promise<SubagentResult> {
      // Claim the child thread before announcing it: a resume of a child that
      // is still running must not start a second run on the same thread.
      const claimed = runManager.claim(threadId, subRunId);
      if (!claimed.ok) {
        return failure(
          spec,
          'error',
          `Sub-agent ${threadId} is still running. Wait for its report or start a new one.`,
          threadId,
        );
      }
      const { claim } = claimed;
      try {
        if (!(await claim.ready)) {
          claim.release();
          return failure(spec, 'error', `Sub-agent ${threadId} is still stopping. Try again shortly.`, threadId);
        }
        // Persist the opening brief so the child thread reads as a conversation.
        const opening = messages[messages.length - 1];
        if (opening?.role === 'user' && typeof opening.content === 'string') {
          await host.append({
            threadId,
            runId: subRunId,
            record: { role: 'user', content: opening.content },
          });
        }
        const modelCall = await host.modelCall(model, profile.thinking);
        // Replaced when the run finishes; survives only if the server stops first.
        await host
          .writeLastRun(threadId, lastRunFrom({ runId: subRunId, outcome: 'interrupted', iterations: 0, toolCalls: 0 }))
          .catch(() => undefined);
        claim.start({
          model,
          mode: 'workspace',
          posture: parent.posture,
          messages,
          tools,
          modelCall,
          limits: {
            maxIterations: granted.maxIterations,
            maxToolCalls: granted.maxToolCalls,
            maxRepeatedToolCalls: CHILD_RUN.maxRepeatedToolCalls,
            toolTimeoutMs: CHILD_RUN.toolTimeoutMs,
            maxWallMs: profile.limits.maxWallMs,
            maxPromptTokens: carve,
          },
          contextBudget,
          flags: parent.flags,
          ...(parent.workspaceRoot
            ? { workspaceRoot: parent.workspaceRoot }
            : {}),
          putBlob: (text) => host.putBlob(threadId, text),
          ...(parent.recordCalls ? { recordCalls: true } : {}),
          readBlob: (sha, offset, length) =>
            host.readBlob(threadId, sha, offset, length),
          onMessage: async (record, meta) => {
            if (record.role === 'system') return;
            await host.append({
              threadId,
              runId: subRunId,
              record,
              ...(meta ? { meta } : {}),
            });
          },
          ...(host.trace(threadId) ? { trace: host.trace(threadId)! } : {}),
          depth: parent.depth + 1,
          parentRunId: parent.runId,
          ...(parent.capacity ? { capacity: parent.capacity } : {}),
          ...(profile.context === 'fork' ? { webTrust: parent.webTrust() } : {}),
        }, {
          parentSignal: parent.signal,
          // The parent's card holds the result; the child's events are only for progress.
          retainMs: 1_000,
        });
      } catch (error) {
        claim.release();
        throw error;
      }

      parent.emit?.({
        type: 'subrun.started',
        runId: parent.runId,
        subRunId,
        parentRunId: parent.runId,
        subThreadId: threadId,
        profile: profile.name,
        task: spec.objective,
      });

      // Throttled progress for the parent's card.
      let toolCalls = 0;
      let lastTool: string | undefined;
      let lastSent = 0;
      // Live roll-up: the parent's budget sees the child's spend as it
      // happens (each turn's running total), not only when the child ends;
      // the rest is charged at settle. Never charged twice.
      const charged = emptyRunUsage().own;
      const chargeUpTo = (usage: RunUsage) => {
        const delta = usageDelta(totalRunUsage(usage), charged);
        if (delta.promptTokens + delta.completionTokens + delta.calls + delta.estimatedCalls === 0) return;
        parent.chargeUsage({ own: delta, children: emptyRunUsage().children });
        charged.promptTokens += delta.promptTokens;
        charged.completionTokens += delta.completionTokens;
        charged.calls += delta.calls;
        charged.estimatedCalls += delta.estimatedCalls;
      };
      const progress = runManager.subscribe(subRunId, 0, (event) => {
        if (event.type === 'turn.completed') {
          if (event.runUsage) chargeUpTo(event.runUsage);
          return;
        }
        if (event.type !== 'tool.completed') return;
        toolCalls += 1;
        lastTool = event.toolName;
        const now = Date.now();
        if (now - lastSent < PROGRESS_INTERVAL_MS) return;
        lastSent = now;
        parent.emit?.({
          type: 'subrun.progress',
          runId: parent.runId,
          subRunId,
          toolCalls,
          ...(lastTool ? { lastTool } : {}),
        });
      });

      const { result, outcome } = await runManager.wait(subRunId);
      progress?.unsubscribe();
      const status: SubagentStatus =
        parent.signal.aborted || outcome === 'cancelled' ? 'cancelled' : result.status;

      // The report is built from what the child recorded (checked against
      // the workspace) plus what its `report` call added; without a report
      // call, the record alone still reaches the parent.
      const recorded = result.task?.evidence.findings ?? [];
      const merged = profile.report
        ? mergeReportFindings(report, recorded, result.content.trim().slice(0, FALLBACK_SUMMARY_MAX_CHARS))
        : undefined;
      const body = merged ? renderReport(merged) : result.content.trim() || '(no answer)';
      // Full body lives with the parent so the parent's `recall` can read it.
      let reportSha: string | undefined;
      try {
        reportSha = await host.putBlob(
          parent.threadId,
          merged ? `${body}\n\n${JSON.stringify(merged, null, 2)}` : body,
        );
      } catch {
        // The digest still carries the bounded body.
      }
      const reportStatus = profile.report ? reportStatusOf(status, result.limitReason, merged) : undefined;
      const findings: TaskFinding[] = (merged?.findings ?? [])
        .filter((finding) => finding.evidence)
        .map((finding) => ({
          claim: finding.claim,
          evidence: finding.evidence!,
          verification: finding.verification ?? 'skipped',
          iteration: 0,
        }));
      const openQuestions = merged?.openQuestions ?? [];
      if (findings.length > 0 || openQuestions.length > 0) {
        parent.trace?.({
          type: 'child_findings',
          runId: parent.runId,
          iteration: parent.iteration?.() ?? 0,
          subRunId,
          findings,
          openQuestions,
        });
      }
      const prefix =
        status === 'completed'
          ? ''
          : `Run ${status}${result.limitReason ? ` (${result.limitReason})` : ''}.\n`;
      // The status prefix counts inside the digest bound.
      const digest = renderDigest(merged ?? body, reportSha, prefix);

      chargeUpTo(result.usage);
      host.trace(threadId)?.({
        type: 'child_finish',
        runId: subRunId,
        parentRunId: parent.runId,
        profile: profile.name,
        status,
        ...(reportStatus ? { reportStatus } : {}),
        toolCalls: result.toolCalls,
        promptTokens: totalRunUsage(result.usage).promptTokens,
        findings: findings.length,
      });
      try {
        await host.writeLastRun(
          threadId,
          lastRunFrom({
            runId: subRunId,
            outcome: status,
            iterations: result.iterations,
            toolCalls: result.toolCalls,
            ...(result.limitReason ? { limitReason: result.limitReason } : {}),
          }),
        );
      } catch {
        // lastRun is a resume hint; the ledger already holds the run.
      }

      parent.emit?.({
        type: 'subrun.settled',
        runId: parent.runId,
        subRunId,
        parentRunId: parent.runId,
        subThreadId: threadId,
        status,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        summary: body.slice(0, 2_000),
        usage: result.usage,
        ...(result.limitReason ? { limitReason: result.limitReason } : {}),
      });
      return {
        subRunId,
        subThreadId: threadId,
        profile: profile.name,
        status,
        digest,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        usage: result.usage,
        ...(reportSha ? { reportSha } : {}),
        ...(result.limitReason ? { limitReason: result.limitReason } : {}),
        ...(reportStatus ? { reportStatus } : {}),
        ...(findings.length ? { findings } : {}),
        ...(openQuestions.length ? { openQuestions } : {}),
      };
    }
  }

  return async (spec, parent) => {
    const profile = getSubagentProfile(spec.profile);
    if (!profile)
      return failure(spec, 'error', `Unknown profile "${spec.profile}".`);
    if (parent.depth >= 1) {
      return failure(
        spec,
        'error',
        'Sub-agents cannot delegate. Do the task yourself.',
      );
    }
    if (parent.signal.aborted)
      return failure(spec, 'cancelled', 'Parent run was cancelled.');

    // Identical briefs in flight for this parent share one child.
    const key = [
      parent.runId,
      spec.profile,
      spec.objective,
      spec.scope,
      spec.resume ?? '',
    ].join('\u0000');
    const existing = inflight.get(key);
    if (existing) return existing;

    // Overlap is refused, not merged: two children reading the same files
    // cost the run twice for one answer. Only briefs that name paths are
    // checked; the refusal says which child covers it, so the parent waits
    // for that report or narrows the scope.
    const paths = normalizeScopePaths(spec.paths);
    const running = activePaths.get(parent.runId) ?? new Map<string, string[]>();
    for (const [objective, covered] of running) {
      const hit = overlappingPath(paths, covered);
      if (!hit) continue;
      parent.trace?.({
        type: 'policy_decision',
        runId: parent.runId,
        iteration: parent.iteration?.() ?? 0,
        kind: 'delegation',
        ids: [`delegate_overlap:${hit}`],
        reason: 'brief overlaps a running sub-agent',
        inputs: { path: hit },
      });
      return failure(
        spec,
        'error',
        `Not started: ${hit} is already covered by a running sub-agent ("${objective.slice(0, 80)}"). Wait for its report, or delegate a scope it does not cover.`,
      );
    }
    if (paths.length > 0) {
      running.set(spec.objective, paths);
      activePaths.set(parent.runId, running);
    }

    let parentSlots = slots.get(parent.runId);
    if (!parentSlots) {
      parentSlots = new Slots(deps.maxConcurrent ?? MAX_CONCURRENT_SUBAGENTS);
      slots.set(parent.runId, parentSlots);
    }
    const slotsForRun = parentSlots;

    const promise = (async () => {
      try {
        await slotsForRun.acquire(parent.signal);
      } catch {
        return failure(spec, 'cancelled', 'Parent run was cancelled.');
      }
      try {
        return await run(spec, parent, profile);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return failure(spec, 'error', `Sub-agent failed: ${message}`);
      } finally {
        slotsForRun.release();
        if (slotsForRun.idle) slots.delete(parent.runId);
      }
    })();
    inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      inflight.delete(key);
      if (paths.length > 0) {
        running.delete(spec.objective);
        if (running.size === 0) activePaths.delete(parent.runId);
      }
    }
  };
}

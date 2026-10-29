import { randomUUID } from 'node:crypto';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import {
  emptyRunUsage,
  type ContextBudget,
  type LedgerAppendMeta,
  type LedgerRecord,
  type ModelRole,
  type SubagentReport,
  type SubagentResult,
  type SubagentSpec,
  type SubagentStatus,
  type ThreadLastRun,
  type TraceEvent,
} from '@agent/agent-models';

import type {
  ModelCallFn,
  RunLoopResult,
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
  renderReport,
} from './prompt';
import { getSubagentProfile } from './profiles';
import {
  CHILD_BUDGET_SHARE,
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
  /** Call function with that model's own options (temperature, thinking, window). */
  modelCall(model: string): Promise<ModelCallFn>;
  /** Context budget for a model at the default window. */
  contextBudget(model: string): Promise<ContextBudget>;
  agentsMd(workspaceRoot: string): Promise<string>;
  trace(threadId: string): ((event: TraceEvent) => void) | undefined;
};

const PROGRESS_INTERVAL_MS = 1_000;

function clampTitle(text: string): string {
  const words = text.trim().split(/\s+/).filter(Boolean).slice(0, 7);
  return words.length ? words.join(' ') : 'Sub-agent';
}

/** Last user-authored message before the parent's current tool turn. */
function lastUserRequest(
  messages: ChatCompletionMessageParam[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    return message.content
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join('\n');
  }
  return undefined;
}

function childStatus(
  result: RunLoopResult,
  cancelled: boolean,
): SubagentStatus {
  if (cancelled) return 'cancelled';
  return result.status;
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
      const onAbort = () => reject(new Error('Run cancelled'));
      signal.addEventListener('abort', onAbort, { once: true });
      this.queue.push(() => {
        signal.removeEventListener('abort', onAbort);
        this.active += 1;
        resolve();
      });
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

    // Refuse before creating a thread when the parent has nothing left to share.
    if (
      parent.remainingPromptTokens !== undefined &&
      Math.floor(
        Math.max(0, parent.remainingPromptTokens - (reserved.get(parent.runId) ?? 0)) *
          CHILD_BUDGET_SHARE,
      ) <= 0
    ) {
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
      const available = Math.min(
        profile.limits.maxPromptTokens,
        Math.floor(
          Math.max(0, parent.remainingPromptTokens - (reserved.get(parent.runId) ?? 0)) *
            CHILD_BUDGET_SHARE,
        ),
      );
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
      const brief = buildBrief(
        spec,
        profile.context === 'diff'
          ? lastUserRequest(parentMessages)
          : undefined,
      );
      messages = [
        { role: 'system', content: system },
        ...history,
        { role: 'user', content: brief },
      ];
      contextBudget = await host.contextBudget(model);
    }

    const promised = reserved.get(parent.runId) ?? 0;
    const carve =
      parent.remainingPromptTokens === undefined
        ? profile.limits.maxPromptTokens
        : Math.min(
            profile.limits.maxPromptTokens,
            Math.floor(
              Math.max(0, parent.remainingPromptTokens - promised) *
                CHILD_BUDGET_SHARE,
            ),
          );
    if (carve <= 0) {
      return failure(
        spec,
        'error',
        'No run budget left for a sub-agent. Finish the work yourself.',
        threadId,
      );
    }
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
      parent.emit?.({
        type: 'subrun.started',
        runId: parent.runId,
        subRunId,
        parentRunId: parent.runId,
        subThreadId: threadId,
        profile: profile.name,
        task: spec.objective,
      });

      // Persist the opening brief so the child thread reads as a conversation.
      const opening = messages[messages.length - 1];
      if (opening?.role === 'user' && typeof opening.content === 'string') {
        await host.append({
          threadId,
          runId: subRunId,
          record: { role: 'user', content: opening.content },
        });
      }

      const modelCall = await host.modelCall(model);
      runManager.start({
        runId: subRunId,
        threadId,
        model,
        mode: 'workspace',
        posture: parent.posture,
        messages,
        tools,
        modelCall,
        limits: {
          maxIterations: profile.limits.maxIterations,
          maxToolCalls: profile.limits.maxToolCalls,
          maxRepeatedToolCalls: 3,
          toolTimeoutMs: 60_000,
          maxWallMs: profile.limits.maxWallMs,
          maxPromptTokens: carve,
        },
        contextBudget,
        ...(parent.workspaceRoot
          ? { workspaceRoot: parent.workspaceRoot }
          : {}),
        putBlob: (text) => host.putBlob(threadId, text),
        readBlob: (sha, offset, length) =>
          host.readBlob(threadId, sha, offset, length),
        onMessage: async (record, meta) => {
          if (record.role === 'system') return;
          await host.append({
            threadId,
            runId: subRunId,
            record,
            meta: { ...(meta ?? {}), parentRunId: parent.runId, subRunId },
          });
        },
        ...(host.trace(threadId) ? { trace: host.trace(threadId)! } : {}),
        depth: parent.depth + 1,
        parentRunId: parent.runId,
        parentSignal: parent.signal,
        ...(parent.capacity ? { capacity: parent.capacity } : {}),
      });

      // Throttled progress for the parent's card.
      let toolCalls = 0;
      let lastTool: string | undefined;
      let lastSent = 0;
      const unsubscribe = runManager.subscribe(subRunId, 0, (event) => {
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

      const result = await runManager.wait(subRunId);
      unsubscribe();
      const cancelled =
        parent.signal.aborted || runManager.get(subRunId)?.cancelled === true;
      setTimeout(() => runManager.clear(subRunId), 1_000);

      const status = childStatus(result, cancelled);
      const body = report
        ? renderReport(report)
        : result.content.trim() || '(no answer)';
      // Full body lives with the parent so the parent's `recall` can read it.
      const reportSha = await host.putBlob(
        parent.threadId,
        report ? `${body}\n\n${JSON.stringify(report, null, 2)}` : body,
      );
      const prefix =
        status === 'completed'
          ? ''
          : `Run ${status}${result.limitReason ? ` (${result.limitReason})` : ''}.\n`;
      const digest = renderDigest(`${prefix}${body}`, reportSha);

      parent.chargeUsage(result.usage);
      try {
        await host.writeLastRun(threadId, {
          runId: subRunId,
          status: status === 'completed' ? 'completed' : 'error',
          incomplete: status === 'incomplete',
          iterations: result.iterations,
          toolCalls: result.toolCalls,
          finishedAt: new Date().toISOString(),
          ...(result.limitReason ? { limitReason: result.limitReason } : {}),
        });
      } catch {
        // lastRun is a resume hint; the ledger already holds the run.
      }

      const settled: SubagentResult = {
        subRunId,
        subThreadId: threadId,
        profile: profile.name,
        status,
        digest,
        iterations: result.iterations,
        toolCalls: result.toolCalls,
        usage: result.usage,
        reportSha,
        ...(result.limitReason ? { limitReason: result.limitReason } : {}),
      };
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
      return settled;
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
    }
  };
}

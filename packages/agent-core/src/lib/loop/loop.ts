import { randomUUID } from 'node:crypto';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

import {
  CHARS_PER_TOKEN,
  ChoiceSkipped,
  DEFAULT_CONTEXT_BUDGET,
  emptyRunUsage,
  isAskStrippedTool,
  type AgentEventWithoutSeq,
  type LedgerAppendMeta,
  type RunUsage,
  type TokenUsage,
  type ToolContext,
  type TraceEvent,
} from '@agent/agent-models';

import {
  refreshContextReport,
  stubLiveToolResults,
} from '../context/assemble-context';
import {
  compactCurrentRun,
  evictToolResults,
  ReadDedupe,
  retireSkillBodies,
} from '../context/residency';
import { consoleTrace } from '../events/trace';
import { estimatePromptTokens } from '../model/estimate-prompt-tokens';
import { createEffortRouter, type EffortSignals } from '../system1/effort';
import { buildEffortState } from '../system1/state';
import { getSkill } from '../tools/skills';
import { limitMessage, resolveLimits } from './limits';
import type { ModelTurn } from '../model/types';
import type { Tool, ToolRegistry, ToolStage } from '../tools/types';
import {
  WEB_FETCH_UNTRUSTED_SHA,
  WEB_FETCH_UNTRUSTED_URL,
} from '../tools/web/trust';
import { looksLikeHttpUrl } from '../tools/web/url';
import {
  isEditSuccess,
  outcomeKey,
  pathFromToolArgs,
  toolCallKey,
} from './call-identity';
import { ProgressSteering } from './progress-steering';
import { RepetitionGuard } from './repetition-guard';
import { RunBudget } from './run-budget';
import { throwIfAborted, withTimeout } from './timeout';
import { toLedgerRecord } from './to-ledger-record';
import { WebSourceStore } from './web-sources';
import type { ModelCallFn, RunLoopConfig, RunLoopResult } from './types';

const OPEN_PLAN_WORK_NUDGE =
  'Open todos remain on the Final plan. Update todo status or finish those items before ending the turn. Do not claim the work is done.';

const USER_SKIPPED_CHOICE =
  'User skipped this choice. Stop. Do not assume a path or keep editing.';

/** A tool's declared stage wins; the name table covers built-ins without one. */
function toolStage(name: string, tool?: Tool): ToolStage {
  if (tool?.stage) return tool.stage;
  if (name === 'load_skill') return 'skill';
  if (name === 'glob' || name === 'grep' || name === 'read_file') return 'read';
  if (name === 'web_search' || name === 'web_fetch') return 'network';
  if (name === 'delegate') return 'subagent';
  if (name === 'run_terminal') return 'exec';
  return 'mutate';
}

export type {
  ModelCallFn,
  RunLoopConfig,
  RunLoopResult,
  RunLoopStatus,
} from './types';

/* ---------- internal helpers ---------- */

/**
 * Cap for `tool.completed` result previews carried on the live event stream.
 * Large enough to carry a full read_file / run_terminal result for the UI's
 * inline preview; the host ledger still holds the unbounded result. Short
 * status strings (blocked, USER_SKIPPED_CHOICE) keep their own smaller caps.
 */
const RESULT_PREVIEW_MAX = 20_000;

function preview(value: unknown, max = 300): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Compact preview so UI labels are not poisoned by truncated newText/oldText. */
function toolArgsPreview(toolName: string, args: unknown): string {
  if (
    toolName === 'edit_file' &&
    args &&
    typeof args === 'object' &&
    !Array.isArray(args)
  ) {
    const record = args as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path : '';
    const oldText = typeof record.oldText === 'string' ? record.oldText : '';
    const intent = oldText.length > 0 ? 'patch' : 'create';
    return preview({ path, intent }, 200);
  }
  if (
    toolName === 'offer_choice' &&
    args &&
    typeof args === 'object' &&
    !Array.isArray(args)
  ) {
    const record = args as Record<string, unknown>;
    return preview(
      {
        question:
          typeof record.question === 'string'
            ? record.question.slice(0, 120)
            : '',
      },
      200,
    );
  }
  if (
    (toolName === 'plan' || toolName === 'todo') &&
    args &&
    typeof args === 'object' &&
    !Array.isArray(args)
  ) {
    const record = args as Record<string, unknown>;
    if (toolName === 'plan') {
      return preview(
        {
          action: record.action,
          kind: record.kind,
          text:
            typeof record.text === 'string'
              ? record.text.slice(0, 80)
              : undefined,
        },
        200,
      );
    }
    const todos = Array.isArray(record.todos) ? record.todos.length : 0;
    return preview({ merge: record.merge, todos }, 200);
  }
  return preview(args, 200);
}

/** Partial reads of one file (since its last edit) between grep hints. */
const READ_CREEP_NOTE_EVERY = 3;

const SKIP_LIMIT_REACHED = limitMessage(
  'limit.tools',
  'Skipped: tool call limit reached.',
);
const REPEAT_BLOCKED = limitMessage(
  'limit.repeat',
  'This exact tool call has already been attempted multiple times. Do not repeat it.',
);

/* ---------- the loop ---------- */

/**
 * The agent state machine. Iterates: model call → tool execution → next model call.
 *
 * Contract: observe tools per *turn* (batch → append every tool_call_id → next
 * model call). Never model-after-each-tool. Gates dispose; prompts do not.
 * Emits AgentEvents via config.emit (for SSE/UI) AND traces via config.trace
 * (for eval/console). Durable turns go through config.onMessage (host ledger).
 */
/**
 * Run the agent loop. The wrapper owns run-wide accounting: every result
 * carries token usage (own + sub-agents), and one `run_finish` trace closes
 * the run whichever path ended it.
 */
export async function runLoop(
  modelCall: ModelCallFn,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  config: RunLoopConfig,
): Promise<RunLoopResult> {
  const runId = config.runId ?? randomUUID();
  const trace = config.trace ?? ((event: TraceEvent) => consoleTrace(event));
  const usage = emptyRunUsage();
  const startedAt = Date.now();
  const result = await runLoopCore(modelCall, messages, tools, {
    ...config,
    runId,
    trace,
  }, usage, startedAt);
  await reportSystem1(config, runId, trace);
  trace({
    type: 'run_finish',
    runId,
    iterations: result.iterations,
    toolCalls: result.toolCalls,
    status: result.status,
    ...(result.limitReason ? { limitReason: result.limitReason } : {}),
    usage,
    durationMs: Date.now() - startedAt,
  });
  return { ...result, usage };
}

/**
 * End-of-run System 1 summary: always to the trace, and to the client when
 * any decision fell back. Sub-agent runs report through their own trace only.
 * Never throws — reporting must not change how the run ended.
 */
async function reportSystem1(
  config: RunLoopConfig,
  runId: string,
  trace: (event: TraceEvent) => void,
): Promise<void> {
  const system1 = config.system1;
  if (!system1) return;
  try {
    await system1.settle();
    const report = system1.report();
    if (!report) return;
    trace({ type: 'system1_report', runId, report });
    if (report.fallbacks.length > 0 && (config.depth ?? 0) === 0) {
      config.emit?.({ type: 'system1.report', runId, report });
    }
  } catch (error) {
    console.error('[system1] report failed:', error instanceof Error ? error.message : error);
  }
}

type CoreResult = Omit<RunLoopResult, 'usage'>;

const BUDGET_NUDGE =
  'Run budget nearly spent. Finish the current step, run verification once, and report what is done and what is left. Do not start new work.';
const ADVISOR_HINT =
  'The same command produced the same result twice. If you are stuck, delegate to the advisor profile with the specific question instead of retrying.';

async function runLoopCore(
  modelCall: ModelCallFn,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  config: RunLoopConfig & { runId: string; trace: (event: TraceEvent) => void },
  usage: RunUsage,
  runStartedAt: number,
): Promise<CoreResult> {
  const limits = resolveLimits(config.limits);
  // Rule inputs for the effort router, read from events the loop already
  // traces; cleared after every model call.
  const turnSignals = { toolError: false, wrote: false, nudged: false };
  const trace = (event: TraceEvent) => {
    if (event.type === 'tool_error') turnSignals.toolError = true;
    else if (
      event.type === 'tool_start' &&
      (event.toolName === 'edit_file' || event.toolName === 'run_terminal' || event.toolName === 'delegate')
    ) {
      turnSignals.wrote = true;
    } else if (event.type === 'stall_nudge' || event.type === 'budget_warning') {
      turnSignals.nudged = true;
    }
    config.trace(event);
  };
  const effortRouter = createEffortRouter();
  // run.completed and turn.completed carry run spend so the UI meter and
  // offline traces never have to sum per-call usage themselves.
  const emit = config.emit
    ? (event: AgentEventWithoutSeq) => {
        if (event.type === 'run.completed') {
          config.emit!({ ...event, usage: budget.snapshot() });
        } else if (event.type === 'turn.completed') {
          config.emit!({ ...event, runUsage: budget.snapshot() });
        } else {
          config.emit!(event);
        }
      }
    : undefined;
  const runId = config.runId;
  const threadId = config.threadId ?? 'unknown';
  const signal = config.signal;
  const origin = config.origin ?? 'chat';

  const posture = config.posture ?? 'agent';
  const budget = new RunBudget(usage, limits, runStartedAt);
  // Progress steering applies to a capped parent run that can edit. Ask runs
  // cannot edit, Home has no edit_file, and sub-agents never edit.
  const steering = new ProgressSteering(
    budget,
    limits.maxPromptTokens !== undefined &&
      (config.depth ?? 0) === 0 &&
      posture === 'agent' &&
      tools.byName.has('edit_file'),
    () => config.capacity?.conserve() === true,
  );
  const guard = new RepetitionGuard();
  const webSources = new WebSourceStore({
    ...(config.putBlob ? { putBlob: config.putBlob } : {}),
    ...(config.readBlob ? { readBlob: config.readBlob } : {}),
  });

  let iterations = 0;
  let totalToolCalls = 0;
  let planWorkNudges = 0;
  let lastLimitReason: string | undefined;
  // Index of the first message this run appends; in-run compaction never
  // touches anything before it (system layers + prior turns stay cacheable).
  const runStart = messages.length;
  const readDedupe = new ReadDedupe();
  // load_skill results still resident in full: tool_call_id → name + iteration.
  const skillLoads = new Map<string, { name: string; iteration: number }>();
  // Partial reads per path since its last edit.
  const partialReadsByPath = new Map<string, number>();
  let advisorHinted = false;
  let prefixHeavy = false;
  let stopContent: string | undefined;

  function maybeWarnBudget(): void {
    const spent = budget.takeWarning();
    if (spent === undefined) return;
    // Loop control, not a durable turn: joins the live prompt only.
    messages.push({ role: 'user', content: BUDGET_NUDGE });
    trace({
      type: 'budget_warning',
      runId,
      iteration: iterations,
      reason: 'prompt tokens',
      promptTokens: spent,
      limitPromptTokens: limits.maxPromptTokens!,
    });
  }

  function maybeSteerProgress(): void {
    const stall = steering.takeStallNudge();
    if (!stall) return;
    const { idle, max } = stall;
    const spent = budget.spent();
    const perCall = Math.max(1, estimatePromptTokens(messages, tools.definitions));
    const callsLeft = Math.floor(Math.max(0, max - spent) / perCall);
    const delegate = tools.byName.has('delegate')
      ? ' If one specific fact is still missing, delegate(explore) with that question instead of searching more yourself.'
      : '';
    // Loop control, not a durable turn: joins the live prompt only.
    messages.push({
      role: 'user',
      content: `${Math.round(idle / 1000)}k prompt tokens (${Math.round((idle / max) * 100)}% of this run's budget) went to steps with no edit. About ${callsLeft} model calls remain at the current context size. Act on what you have: make the change, or answer if no change was asked.${delegate}`,
    });
    trace({
      type: 'stall_nudge',
      runId,
      iteration: iterations,
      idleTokens: idle,
      promptTokens: spent,
      limitPromptTokens: max,
    });
  }

  function maybeSuggestAdvisor(): void {
    if (advisorHinted || !tools.byName.has('delegate')) return;
    advisorHinted = true;
    messages.push({ role: 'user', content: ADVISOR_HINT });
  }

  /**
   * Prompt-only residency after a tool turn: cap oversized recent results,
   * evict old results to cards, then collapse old iterations of this run.
   */
  async function manageResidency(): Promise<void> {
    stubLiveToolResults(messages, contextBudget, runStart);

    for (const retired of retireSkillBodies(
      messages,
      skillLoads,
      iterations,
      contextBudget.skillResidentIterations,
    )) {
      // A reload after retirement is legitimate, not a repeat.
      guard.forgetSkillLoads();
      trace({
        type: 'skill_evicted',
        runId,
        iteration: iterations,
        name: retired.name,
        residentIterations: contextBudget.skillResidentIterations,
      });
    }

    const evicted = await evictToolResults(
      messages,
      contextBudget,
      tools.definitions,
      (text) => webSources.putBlob(text),
    );
    if (evicted) {
      readDedupe.forget(evicted.toolCallIds);
      trace({
        type: 'context_evicted',
        runId,
        iteration: iterations,
        evicted: evicted.evicted,
        beforeTokens: evicted.beforeTokens,
        afterTokens: evicted.afterTokens,
      });
    }

    if (prefixHeavy) return;
    const compacted = compactCurrentRun(
      messages,
      runStart,
      contextBudget,
      tools.definitions,
    );
    if (!compacted) return;
    readDedupe.forget(compacted.toolCallIds);
    for (const id of compacted.toolCallIds) skillLoads.delete(id);
    trace({
      type: 'context_compacted_inrun',
      runId,
      iteration: iterations,
      beforeTokens: compacted.beforeTokens,
      afterTokens: compacted.afterTokens,
    });
    if (compacted.prefixHeavy) {
      // Prior turns alone keep the prompt over the low mark. Folding one
      // more iteration per call would rewrite the prefix every call, so stop;
      // pre-run compaction handles this at the next run.
      prefixHeavy = true;
      trace({
        type: 'context_prefix_heavy',
        runId,
        iteration: iterations,
        promptTokens: compacted.afterTokens,
      });
    }
  }

  /**
   * Walking a file a few lines at a time (offset/limit reads) is how a run
   * loses its place; every few partial reads of one file, point at grep.
   */
  function withReadCreepNote(
    readPath: string,
    args: Record<string, unknown>,
    result: string,
  ): string {
    const partial =
      (typeof args.offset === 'number' && args.offset > 1) ||
      typeof args.limit === 'number';
    if (!partial || result.startsWith('[empty file]')) return result;
    const count = (partialReadsByPath.get(readPath) ?? 0) + 1;
    partialReadsByPath.set(readPath, count);
    if (count % READ_CREEP_NOTE_EVERY !== 0) return result;
    trace({
      type: 'tool_note',
      runId,
      iteration: iterations,
      toolName: 'read_file',
      note: 'read_creep',
      count,
    });
    return `${result}\n\n(note) ${count} partial reads of ${readPath} since it last changed. To find a block, grep for its anchor line (grep returns path:line), then read from that line.`;
  }

  /** Every few in-order slices of one web source, point at query (or explore). */
  function withWebSliceNote(args: Record<string, unknown>, result: string): string {
    const count = webSources.sliceNoteDue(args, result);
    if (count === undefined) return result;
    trace({
      type: 'tool_note',
      runId,
      iteration: iterations,
      toolName: 'web_fetch',
      note: 'web_slices',
      count,
    });
    const delegate = tools.byName.has('delegate')
      ? ', or delegate(explore) to read a long source for you'
      : '';
    return `${result}\n\n(note) ${count} slices of this source read in order; every slice stays in context. Use query="…" to jump to what you need${delegate}.`;
  }

  /** Per-tool result shaping before the result joins the prompt and ledger. */
  function shapeToolResult(
    toolName: string,
    args: Record<string, unknown>,
    raw: string,
    toolCallId: string,
  ): string {
    const cap = tools.byName.get(toolName)?.outputCap;
    const result =
      cap !== undefined && raw.length > cap
        ? `${raw.slice(0, cap)}\n\n(${toolName} output capped at ${cap} chars)`
        : raw;
    if (toolName === 'read_file') {
      const readPath = pathFromToolArgs(args);
      if (readPath === null) return result;
      const shaped = readDedupe.apply(readPath, args, result, iterations, toolCallId);
      return withReadCreepNote(readPath, args, shaped);
    }
    if (toolName === 'web_fetch') {
      return withWebSliceNote(args, result);
    }
    if (toolName === 'load_skill' && !result.startsWith('Skill not found')) {
      const name = String(args.skill_name ?? '').trim();
      skillLoads.set(toolCallId, { name, iteration: iterations });
      trace({
        type: 'skill_loaded',
        runId,
        iteration: iterations,
        name,
        ...(typeof args.section === 'string' ? { section: args.section } : {}),
        tokens: Math.ceil(result.length / CHARS_PER_TOKEN),
        source: 'model',
      });
      return result;
    }
    if (toolName === 'edit_file' && isEditSuccess(result)) {
      const editPath = pathFromToolArgs(args);
      if (editPath !== null) {
        readDedupe.invalidatePath(editPath);
        partialReadsByPath.delete(editPath);
      }
    } else if (toolName === 'run_terminal') {
      readDedupe.clear();
    }
    return result;
  }

  /** A tool (sub-agent `report`) asked to end the run with this answer. */
  async function finishRequestedStop(
    content: string,
    lastUsage?: TokenUsage,
  ): Promise<CoreResult> {
    await appendDurable(
      { role: 'assistant', content },
      { runDurationMs: Date.now() - runStartedAt },
    );
    emitTurnCompleted(iterations, lastUsage);
    emit?.({
      type: 'run.completed',
      runId,
      iterations,
      toolCalls: totalToolCalls,
    });
    return {
      runId,
      content,
      iterations,
      toolCalls: totalToolCalls,
      status: 'completed',
    };
  }

  /**
   * The parent's messages for an advisor fork: everything up to (not
   * including) the assistant turn whose tool calls are still running, so
   * the fork is a valid conversation with the parent's exact prefix.
   */
  function forkMessages(): ChatCompletionMessageParam[] {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role === 'assistant' && message.tool_calls?.length) {
        return messages.slice(0, i);
      }
    }
    return [...messages];
  }

  function noteLimit(reason: string): void {
    lastLimitReason = reason;
    trace({
      type: 'limit',
      runId,
      iteration: iterations,
      reason,
    });
    emit?.({ type: 'limit.hit', runId, reason });
  }
  const contextBudget = config.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
  webSources.seed(messages);

  async function appendDurable(
    message: ChatCompletionMessageParam,
    meta?: LedgerAppendMeta,
  ): Promise<void> {
    messages.push(message);
    if (config.onMessage) {
      await config.onMessage(toLedgerRecord(message), meta);
    }
  }

  function isToolAnswered(toolCallId: string): boolean {
    return messages.some(
      (message) =>
        message.role === 'tool' &&
        'tool_call_id' in message &&
        message.tool_call_id === toolCallId,
    );
  }

  function unansweredToolCalls(
    toolCalls: ChatCompletionMessageToolCall[],
  ): ChatCompletionMessageToolCall[] {
    return toolCalls.filter((toolCall) => !isToolAnswered(toolCall.id));
  }

  /** I1: every tool_call_id gets one durable tool row; never double-answer. */
  async function skipToolCalls(
    toolCalls: ChatCompletionMessageToolCall[],
    reason: string,
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      if (isToolAnswered(toolCall.id)) continue;
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: reason,
      });
    }
  }

  function buildToolContext(): ToolContext {
    return {
      runId,
      threadId,
      origin,
      signal: signal ?? new AbortController().signal,
      ...(config.workspaceRoot !== undefined
        ? { workspaceRoot: config.workspaceRoot }
        : {}),
      ...(config.offerChoice ? { offerChoice: config.offerChoice } : {}),
      ...(config.subagents && tools.byName.has('delegate')
        ? {
            spawnSubagent: (spec) =>
              config.subagents!(spec, {
                runId,
                threadId,
                model: config.model,
                depth: config.depth ?? 0,
                posture,
                signal: signal ?? new AbortController().signal,
                ...(config.workspaceRoot !== undefined
                  ? { workspaceRoot: config.workspaceRoot }
                  : {}),
                toolNames: [...tools.byName.keys()],
                contextBudget,
                remainingPromptTokens: budget.remaining(),
                forkMessages,
                ...(config.emit ? { emit: config.emit } : {}),
                ...(config.pinnedSkills ? { pinnedSkills: config.pinnedSkills } : {}),
                ...(config.capacity ? { capacity: config.capacity } : {}),
                chargeUsage: (child) => budget.chargeChild(child),
              }),
          }
        : {}),
      requestStop: (content) => {
        stopContent = content;
      },
      putBlob: (text) => webSources.putBlob(text),
      readBlob: (sha, offset, length) => webSources.readBlob(sha, offset, length),
      noteTrustedWebUrls: (urls) => webSources.noteTrustedUrls(urls),
      noteWebSource: (source) => webSources.noteSource(source),
      getWebSource: (sha) => webSources.get(sha),
      getWebSourceByUrl: (url) => webSources.getByUrl(url),
      trace,
    };
  }

  function emitTurnCompleted(iteration: number, usage?: TokenUsage): void {
    const contextReport = config.contextReport
      ? refreshContextReport(config.contextReport, messages, tools, usage)
      : undefined;
    emit?.({
      type: 'turn.completed',
      runId,
      iteration,
      ...(usage ? { usage } : {}),
      ...(contextReport ? { contextReport } : {}),
    });
  }

  type ReadyToolCall = {
    toolCall: ChatCompletionMessageToolCall;
    toolName: string;
    tool: Tool;
    args: Record<string, unknown>;
  };

  type AdmitResult =
    | { kind: 'ready'; call: ReadyToolCall }
    | { kind: 'filled' }
    | {
        kind: 'halt';
        reason: 'limit' | 'repeat';
        toolCall: ChatCompletionMessageToolCall;
      };

  async function admitToolCall(
    toolCall: ChatCompletionMessageToolCall,
  ): Promise<AdmitResult> {
    if (toolCall.type !== 'function') {
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: 'Unsupported tool call type.',
      });
      return { kind: 'filled' };
    }

    const toolName = toolCall.function.name;
    const tool = tools.byName.get(toolName);

    // Rejects always get a tool row (I1) but do not burn maxToolCalls (D10).
    if (!tool) {
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: `Tool "${toolName}" does not exist.`,
      });
      const streakLimit = guard.unknownTool();
      if (streakLimit) {
        noteLimit(streakLimit);
        return { kind: 'halt', reason: 'limit', toolCall };
      }
      return { kind: 'filled' };
    }

    guard.knownTool();

    if (posture === 'ask' && isAskStrippedTool(toolName)) {
      const blocked =
        'Blocked: this run is Ask (read-only). Switch the composer to Agent to edit files or run commands.';
      emit?.({
        type: 'tool.started',
        runId,
        toolCallId: toolCall.id,
        toolName,
        argsPreview: toolArgsPreview(toolName, {}),
      });
      emit?.({
        type: 'tool.completed',
        runId,
        toolCallId: toolCall.id,
        toolName,
        durationMs: 0,
        resultPreview: preview(blocked, 200),
      });
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: blocked,
      });
      return { kind: 'filled' };
    }

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(toolCall.function.arguments);
    } catch {
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: 'Invalid tool arguments. Expected valid JSON.',
      });
      return { kind: 'filled' };
    }

    if (toolName === 'web_fetch') {
      const sha =
        typeof args.sha256 === 'string' ? args.sha256.trim().toLowerCase() : '';
      const url = typeof args.url === 'string' ? args.url.trim() : '';
      if (sha) {
        if (!webSources.trustsSha(sha)) {
          const blocked = WEB_FETCH_UNTRUSTED_SHA;
          emit?.({
            type: 'tool.started',
            runId,
            toolCallId: toolCall.id,
            toolName,
            argsPreview: toolArgsPreview(toolName, args),
          });
          emit?.({
            type: 'tool.completed',
            runId,
            toolCallId: toolCall.id,
            toolName,
            durationMs: 0,
            resultPreview: preview(blocked, 200),
          });
          await appendDurable({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: blocked,
          });
          return { kind: 'filled' };
        }
      } else if (looksLikeHttpUrl(url)) {
        if (!webSources.trustsUrl(url)) {
          const blocked = WEB_FETCH_UNTRUSTED_URL;
          emit?.({
            type: 'tool.started',
            runId,
            toolCallId: toolCall.id,
            toolName,
            argsPreview: toolArgsPreview(toolName, args),
          });
          emit?.({
            type: 'tool.completed',
            runId,
            toolCallId: toolCall.id,
            toolName,
            durationMs: 0,
            resultPreview: preview(blocked, 200),
          });
          await appendDurable({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: blocked,
          });
          return { kind: 'filled' };
        }
      }
    } else if (toolName === 'web_search') {
      const candidate = String(args.query ?? '').trim();
      if (looksLikeHttpUrl(candidate)) {
        if (!webSources.trustsUrl(candidate)) {
          const blocked = WEB_FETCH_UNTRUSTED_URL;
          emit?.({
            type: 'tool.started',
            runId,
            toolCallId: toolCall.id,
            toolName,
            argsPreview: toolArgsPreview(toolName, args),
          });
          emit?.({
            type: 'tool.completed',
            runId,
            toolCallId: toolCall.id,
            toolName,
            durationMs: 0,
            resultPreview: preview(blocked, 200),
          });
          await appendDurable({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: blocked,
          });
          return { kind: 'filled' };
        }
      }
    }

    // Research gate: after half the budget with no edit or sub-agent report,
    // the parent's own web tools close until progress. A refusal row, not a
    // halt: reads, edits and delegate(explore) still work.
    if (
      (toolName === 'web_search' || toolName === 'web_fetch') &&
      steering.researchGated()
    ) {
      const idle = steering.idleTokens();
      const delegate = tools.byName.has('delegate')
        ? ' If one specific fact is still missing, delegate(explore) with that question.'
        : '';
      const blocked = limitMessage(
        'limit.research',
        `Web research is paused for this run: ${Math.round((idle / limits.maxPromptTokens!) * 100)}% of the budget went to steps with no edit. It reopens after your next edit or sub-agent report. Use what you have.${delegate}`,
      );
      if (steering.noteGated()) {
        trace({
          type: 'research_gate',
          runId,
          iteration: iterations,
          toolName,
          idleTokens: idle,
        });
      }
      emit?.({
        type: 'tool.started',
        runId,
        toolCallId: toolCall.id,
        toolName,
        argsPreview: toolArgsPreview(toolName, args),
      });
      emit?.({
        type: 'tool.completed',
        runId,
        toolCallId: toolCall.id,
        toolName,
        durationMs: 0,
        resultPreview: preview(blocked, 200),
      });
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: blocked,
      });
      return { kind: 'filled' };
    }

    const readPath =
      toolName === 'read_file' ? pathFromToolArgs(args) : null;
    const stormLimit =
      (readPath !== null ? guard.readStorm(readPath) : null) ??
      (toolName === 'run_terminal' ? guard.terminalStorm() : null);
    if (stormLimit) {
      noteLimit(stormLimit);
      return { kind: 'halt', reason: 'limit', toolCall };
    }

    if (
      limits.maxToolCalls !== undefined &&
      totalToolCalls >= limits.maxToolCalls
    ) {
      noteLimit(
        limitMessage(
          'limit.tools',
          `max tool calls exceeded (${limits.maxToolCalls})`,
        ),
      );
      return { kind: 'halt', reason: 'limit', toolCall };
    }

    const repeatCount = guard.countCall(toolCallKey(toolName, args));

    // Exec tools (run_terminal) are exempt from the arg-repeat guard: re-running
    // the same build after an edit is legitimate verification, and outcome dedup
    // (MAX_IDENTICAL_OUTCOMES) catches true stuck-ness. The arg-repeat guard
    // stays for mutate/read/network/skill.
    if (
      repeatCount > limits.maxRepeatedToolCalls &&
      toolStage(toolName, tool) !== 'exec'
    ) {
      noteLimit(
        limitMessage('limit.repeat', `repeated tool call blocked: ${toolName}`),
      );
      return { kind: 'halt', reason: 'repeat', toolCall };
    }

    totalToolCalls += 1;
    guard.admitted(toolName, readPath);

    return {
      kind: 'ready',
      call: { toolCall, toolName, tool, args },
    };
  }

  async function finishHalt(
    halt: Extract<AdmitResult, { kind: 'halt' }>,
    fromIndex: number,
    toolCalls: ChatCompletionMessageToolCall[],
  ): Promise<CoreResult> {
    const triggerAnswered = isToolAnswered(halt.toolCall.id);
    if (halt.reason === 'repeat') {
      if (!triggerAnswered) {
        await appendDurable({
          role: 'tool',
          tool_call_id: halt.toolCall.id,
          content: REPEAT_BLOCKED,
        });
      }
      await skipToolCalls(toolCalls.slice(fromIndex + 1), SKIP_LIMIT_REACHED);
    } else if (triggerAnswered) {
      await skipToolCalls(toolCalls.slice(fromIndex + 1), SKIP_LIMIT_REACHED);
    } else {
      await skipToolCalls(toolCalls.slice(fromIndex), SKIP_LIMIT_REACHED);
    }
    return completeAfterLimit();
  }

  function lastAssistantContent(): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role !== 'assistant') continue;
      return typeof message.content === 'string' ? message.content : '';
    }
    return '';
  }

  function finishChoiceSkipped(): CoreResult {
    emitTurnCompleted(iterations);
    emit?.({
      type: 'run.completed',
      runId,
      iterations,
      toolCalls: totalToolCalls,
      incomplete: true,
    });
    return {
      runId,
      content: lastAssistantContent(),
      iterations,
      toolCalls: totalToolCalls,
      status: 'incomplete',
    };
  }

  async function executeReadyCall(
    call: ReadyToolCall,
    remainingOnAbort: ChatCompletionMessageToolCall[],
  ): Promise<'ok' | 'deferred' | 'halted'> {
    const { toolCall, toolName, tool, args } = call;
    const toolCtx = buildToolContext();

    trace({
      type: 'tool_start',
      runId,
      iteration: iterations,
      toolName,
      args,
    });
    emit?.({
      type: 'tool.started',
      runId,
      toolCallId: toolCall.id,
      toolName,
      argsPreview: toolArgsPreview(toolName, args),
    });

    const startedAt = Date.now();

    try {
      // exec tools and delegate own their timeout + process-tree kill.
      // The loop's withTimeout would race the tool's timer and leak the child.
      const ownsTimeout = toolName === 'offer_choice' || tool.risk === 'exec' || toolName === 'delegate';
      const raw = await withTimeout(
        tool.execute(args, toolCtx),
        ownsTimeout ? 0 : limits.toolTimeoutMs,
        signal,
      );
      const result = shapeToolResult(toolName, args, raw, toolCall.id);
      const durationMs = Date.now() - startedAt;
      trace({
        type: 'tool_complete',
        runId,
        iteration: iterations,
        toolName,
        durationMs,
        resultPreview: preview(result),
        resultChars: raw.length,
      });
      emit?.({
        type: 'tool.completed',
        runId,
        toolCallId: toolCall.id,
        toolName,
        durationMs,
        resultPreview: preview(result, RESULT_PREVIEW_MAX),
      });
      // Append before outcome halt so I1 always holds for the triggering call.
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: result,
      });
      // Mutate + exec: same call + same result = stuck (e.g. write theater,
      // or run_terminal producing the same exit code with no edit between).
      const stage = toolStage(toolName, tool);
      if (stage === 'mutate' || stage === 'exec') {
        const outcome = guard.recordOutcome(
          outcomeKey(toolName, args, result),
          stage === 'exec',
        );
        if (outcome.nearStuck) maybeSuggestAdvisor();
        if (outcome.stuck) {
          noteLimit(
            limitMessage(
              'limit.outcome',
              `repeated identical tool outcome blocked: ${toolName}`,
            ),
          );
          return 'halted';
        }
      }
      // A successful edit_file is progress: prior exec outcomes (build/lint
      // exits) are now stale. Clear them so the next verification cycle starts
      // fresh instead of accumulating toward a false stuck-ness halt.
      if (toolName === 'edit_file' && isEditSuccess(result)) {
        guard.editSucceeded();
        steering.markProgress();
      }
      return 'ok';
    } catch (error) {
      if (signal?.aborted) {
        await skipToolCalls(remainingOnAbort, 'Skipped: run cancelled.');
        throwIfAborted(signal);
      }
      if (error instanceof ChoiceSkipped) {
        emit?.({
          type: 'tool.completed',
          runId,
          toolCallId: toolCall.id,
          toolName,
          durationMs: Date.now() - startedAt,
          resultPreview: preview(USER_SKIPPED_CHOICE, 200),
        });
        await appendDurable({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: USER_SKIPPED_CHOICE,
        });
        await skipToolCalls(
          remainingOnAbort.slice(1),
          'Skipped: user deferred this choice.',
        );
        return 'deferred';
      }
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      trace({
        type: 'tool_error',
        runId,
        iteration: iterations,
        toolName,
        error: errorMessage,
      });
      emit?.({
        type: 'tool.failed',
        runId,
        toolCallId: toolCall.id,
        error: errorMessage,
      });
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: `Tool execution failed: ${errorMessage}`,
      });
      return 'ok';
    }
  }

  async function executeReadyBatch(
    batch: ReadyToolCall[],
    remainingAfter: ChatCompletionMessageToolCall[],
  ): Promise<'ok' | 'deferred' | 'halted'> {
    // write/exec and interactive tools stay serial even if they slip into a batch.
    if (
      batch.length === 1 ||
      batch.some((call) => {
        const risk = call.tool.risk ?? 'read';
        return (
          risk === 'write' ||
          risk === 'exec' ||
          call.toolName === 'offer_choice'
        );
      })
    ) {
      for (let i = 0; i < batch.length; i++) {
        const call = batch[i];
        if (!call) continue;
        const outcome = await executeReadyCall(call, [
          ...batch.slice(i).map((item) => item.toolCall),
          ...remainingAfter,
        ]);
        if (outcome !== 'ok') return outcome;
      }
      return 'ok';
    }

    const toolCtx = buildToolContext();
    for (const call of batch) {
      trace({
        type: 'tool_start',
        runId,
        iteration: iterations,
        toolName: call.toolName,
        args: call.args,
      });
      emit?.({
        type: 'tool.started',
        runId,
        toolCallId: call.toolCall.id,
        toolName: call.toolName,
        argsPreview: toolArgsPreview(call.toolName, call.args),
      });
    }

    const settled = await Promise.all(
      batch.map(async (call) => {
        const started = Date.now();
        try {
          // exec tools and delegate own their timeout + process-tree kill.
          const ownsTimeout =
            call.toolName === 'offer_choice' || call.tool.risk === 'exec' || call.toolName === 'delegate';
          const raw = await withTimeout(
            call.tool.execute(call.args, toolCtx),
            ownsTimeout ? 0 : limits.toolTimeoutMs,
            signal,
          );
          return {
            call,
            ok: true as const,
            result: shapeToolResult(call.toolName, call.args, raw, call.toolCall.id),
            resultChars: raw.length,
            durationMs: Date.now() - started,
          };
        } catch (error) {
          return {
            call,
            ok: false as const,
            error,
            durationMs: Date.now() - started,
          };
        }
      }),
    );

    if (signal?.aborted) {
      await skipToolCalls(
        [...batch.map((call) => call.toolCall), ...remainingAfter],
        'Skipped: run cancelled.',
      );
      throwIfAborted(signal);
    }

    let outcomeHalted = false;
    for (const item of settled) {
      const { call, durationMs } = item;
      if (item.ok) {
        trace({
          type: 'tool_complete',
          runId,
          iteration: iterations,
          toolName: call.toolName,
          durationMs,
          resultPreview: preview(item.result),
          resultChars: item.resultChars,
        });
        emit?.({
          type: 'tool.completed',
          runId,
          toolCallId: call.toolCall.id,
          toolName: call.toolName,
          durationMs,
          resultPreview: preview(item.result, RESULT_PREVIEW_MAX),
        });
        await appendDurable({
          role: 'tool',
          tool_call_id: call.toolCall.id,
          content: item.result,
        });
        // Mutate-stage only; finish appending the batch before returning halted.
        if (toolStage(call.toolName, call.tool) === 'mutate') {
          const outcome = guard.recordOutcome(
            outcomeKey(call.toolName, call.args, item.result),
            false,
          );
          if (outcome.stuck) {
            noteLimit(
              limitMessage(
                'limit.outcome',
                `repeated identical tool outcome blocked: ${call.toolName}`,
              ),
            );
            outcomeHalted = true;
          }
        }
        continue;
      }

      if (signal?.aborted) {
        await skipToolCalls(
          [
            call.toolCall,
            ...settled
              .slice(settled.indexOf(item) + 1)
              .map((entry) => entry.call.toolCall),
            ...remainingAfter,
          ],
          'Skipped: run cancelled.',
        );
        throwIfAborted(signal);
      }

      if (item.error instanceof ChoiceSkipped) {
        emit?.({
          type: 'tool.completed',
          runId,
          toolCallId: call.toolCall.id,
          toolName: call.toolName,
          durationMs,
          resultPreview: preview(USER_SKIPPED_CHOICE, 200),
        });
        await appendDurable({
          role: 'tool',
          tool_call_id: call.toolCall.id,
          content: USER_SKIPPED_CHOICE,
        });
        await skipToolCalls(
          [
            ...settled
              .slice(settled.indexOf(item) + 1)
              .map((entry) => entry.call.toolCall),
            ...remainingAfter,
          ],
          'Skipped: user deferred this choice.',
        );
        return 'deferred';
      }

      const errorMessage =
        item.error instanceof Error ? item.error.message : String(item.error);
      trace({
        type: 'tool_error',
        runId,
        iteration: iterations,
        toolName: call.toolName,
        error: errorMessage,
      });
      emit?.({
        type: 'tool.failed',
        runId,
        toolCallId: call.toolCall.id,
        error: errorMessage,
      });
      await appendDurable({
        role: 'tool',
        tool_call_id: call.toolCall.id,
        content: `Tool execution failed: ${errorMessage}`,
      });
    }
    return outcomeHalted ? 'halted' : 'ok';
  }

  /** Fresh message lifecycle for limit finalization (never reuse the tool-turn id). */
  async function finalizeAnswer(): Promise<{
    content: string;
    usage?: TokenUsage;
  }> {
    const finalMessageId = randomUUID();
    const onTextDelta = (delta: string) => {
      emit?.({
        type: 'assistant.delta',
        runId,
        messageId: finalMessageId,
        delta,
      });
    };

    emit?.({ type: 'assistant.started', runId, messageId: finalMessageId });

    // duration = model-call + stream time; excludes tool execution (on ToolCompleted).
    const startedAt = Date.now();
    const turn = await finalizeWithoutTools(
      modelCall,
      config.model,
      messages,
      onTextDelta,
      signal,
    );
    const content = turn.content ?? '';
    const durationMs = Date.now() - startedAt;
    // The tool-less finalize prompt is everything in `messages` right now.
    budget.chargeOwn(turn.usage, estimatePromptTokens(messages), turn.content);

    await appendDurable(
      {
        role: 'assistant',
        content,
      },
      { durationMs, runDurationMs: Date.now() - runStartedAt },
    );

    emit?.({
      type: 'assistant.completed',
      runId,
      messageId: finalMessageId,
      content,
      durationMs,
    });

    return { content, usage: turn.usage };
  }

  /**
   * Account capacity ran out (or is about to). No final model call: it would
   * fail or spend the last of the allowance. The ledger and plan carry the
   * state; the next run continues from them.
   */
  function finishPaused(reason: string): CoreResult {
    noteLimit(limitMessage('limit.capacity', reason));
    emitTurnCompleted(iterations);
    emit?.({
      type: 'run.completed',
      runId,
      iterations,
      toolCalls: totalToolCalls,
      incomplete: true,
      ...(lastLimitReason ? { limitReason: lastLimitReason } : {}),
    });
    return {
      runId,
      content: lastAssistantContent(),
      iterations,
      toolCalls: totalToolCalls,
      status: 'incomplete',
      ...(lastLimitReason ? { limitReason: lastLimitReason } : {}),
    };
  }

  async function completeAfterLimit(): Promise<CoreResult> {
    stubLiveToolResults(messages, contextBudget, runStart);
    const final = await finalizeAnswer();
    emitTurnCompleted(iterations, final.usage);
    emit?.({
      type: 'run.completed',
      runId,
      iterations,
      toolCalls: totalToolCalls,
      incomplete: true,
      ...(lastLimitReason ? { limitReason: lastLimitReason } : {}),
    });
    return {
      runId,
      content: final.content,
      iterations,
      toolCalls: totalToolCalls,
      status: 'incomplete',
      ...(lastLimitReason ? { limitReason: lastLimitReason } : {}),
    };
  }

  trace({
    type: 'run_start',
    runId,
    model: config.model,
    threadId,
    ...(config.parentRunId ? { parentRunId: config.parentRunId } : {}),
    depth: config.depth ?? 0,
    mode: config.mode,
    posture,
    windowTokens: contextBudget.windowTokens,
    ...(config.contextReport?.windowSource
      ? { windowSource: config.contextReport.windowSource }
      : {}),
    ...(config.contextReport
      ? {
          occupiedTokens: config.contextReport.occupiedTokens,
          layers: config.contextReport.layers,
        }
      : {}),
  });
  emit?.({
    type: 'run.started',
    runId,
    threadId,
    mode: config.mode,
    posture,
    model: config.model,
    ...(config.estimatedPromptTokens !== undefined
      ? { estimatedPromptTokens: config.estimatedPromptTokens }
      : {}),
    ...(config.contextReport ? { contextReport: config.contextReport } : {}),
    ...(limits.maxPromptTokens !== undefined
      ? { maxPromptTokens: limits.maxPromptTokens }
      : {}),
    startedAt: new Date(runStartedAt).toISOString(),
  });
  for (const name of config.pinnedSkills ?? []) {
    const skill = getSkill(name);
    if (!skill) continue;
    trace({
      type: 'skill_loaded',
      runId,
      iteration: 0,
      name: skill.name,
      tokens: Math.ceil(skill.instructions.length / CHARS_PER_TOKEN),
      source: 'pick',
    });
  }

  // Hoisted so the outer catch can skip any unanswered tool calls of the
  // turn in progress when the loop throws — upholds I1 (every tool_call_id
  // gets one durable tool row) on the error path.
  let turnToolCalls: ChatCompletionMessageToolCall[] = [];
  try {
    while (
      limits.maxIterations === undefined ||
      iterations < limits.maxIterations
    ) {
      throwIfAborted(signal);
      iterations++;

      const estimatedPrompt = estimatePromptTokens(messages, tools.definitions);
      // The first call always runs: skipping it to finalize would cost the same.
      const overBudget = budget.exceeded(iterations > 1 ? estimatedPrompt : 0);
      if (overBudget) {
        iterations--;
        noteLimit(overBudget);
        return await completeAfterLimit();
      }
      const capacityPause = config.capacity?.pauseReason() ?? null;
      if (capacityPause) {
        iterations--;
        return finishPaused(capacityPause);
      }

      const effortSignals: EffortSignals = {
        iteration: iterations,
        steering: turnSignals.nudged || messages[messages.length - 1]?.role === 'user',
        toolError: turnSignals.toolError,
        wrote: turnSignals.wrote,
      };
      turnSignals.toolError = false;
      turnSignals.wrote = false;
      turnSignals.nudged = false;
      const decisionIteration = iterations;
      const effort = await effortRouter.decide({
        policy: config.effortPolicy,
        system1: config.system1,
        signals: effortSignals,
        state: () =>
          buildEffortState({
            messages,
            runStart,
            signals: effortSignals,
            ...(limits.maxIterations !== undefined ? { maxIterations: limits.maxIterations } : {}),
            mode: config.mode,
          }),
        ...(signal ? { signal } : {}),
        onTrace: (decision) =>
          trace({ type: 'system1_decision', runId, iteration: decisionIteration, decision }),
      });
      throwIfAborted(signal);
      if (effort.trace) {
        trace({ type: 'system1_decision', runId, iteration: iterations, decision: effort.trace });
      }

      trace({
        type: 'llm_request',
        runId,
        iteration: iterations,
        estimatedPromptTokens: estimatedPrompt,
        ...(effort.wire !== undefined ? { reasoningEffort: effort.wire } : {}),
      });
      emit?.({ type: 'turn.started', runId, iteration: iterations });

      const messageId = randomUUID();
      const onTextDelta = (delta: string) => {
        emit?.({
          type: 'assistant.delta',
          runId,
          messageId,
          delta,
        });
      };

      emit?.({ type: 'assistant.started', runId, messageId });

      // duration = model-call + stream time; excludes tool execution (on ToolCompleted).
      const startedAt = Date.now();
      const turn = await modelCall(
        config.model,
        messages,
        tools,
        onTextDelta,
        signal,
        effort.applied && effort.wire !== undefined ? { reasoningEffort: effort.wire } : undefined,
      );
      throwIfAborted(signal);
      const durationMs = Date.now() - startedAt;
      const usageEstimated = budget.chargeOwn(turn.usage, estimatedPrompt, turn.content);

      trace({
        type: 'llm_response',
        runId,
        iteration: iterations,
        finishReason: turn.finishReason,
        hasToolCalls: Boolean(turn.toolCalls.length),
        contentPreview: turn.content ? preview(turn.content) : undefined,
        ...(turn.usage ? { usage: turn.usage } : {}),
        durationMs,
        ...(usageEstimated ? { usageEstimated } : {}),
      });

      if (turn.toolCalls.length > 0) {
        await appendDurable(
          {
            role: 'assistant',
            content: turn.content || null,
            tool_calls: turn.toolCalls,
          },
          { durationMs },
        );
        turnToolCalls = turn.toolCalls;

        // Tool turns end like any other: the ledger row is durable, so the
        // client can settle this assistant message before tools run.
        emit?.({
          type: 'assistant.completed',
          runId,
          messageId,
          content: turn.content,
          durationMs,
        });

        const ready: ReadyToolCall[] = [];
        let halt: Extract<AdmitResult, { kind: 'halt' }> | null = null;
        let haltIndex = 0;
        steering.startTurn();
        for (let index = 0; index < turn.toolCalls.length; index++) {
          if (signal?.aborted) {
            await skipToolCalls(
              turn.toolCalls.slice(index),
              'Skipped: run cancelled.',
            );
            throwIfAborted(signal);
          }

          const toolCall = turn.toolCalls[index];
          if (!toolCall || toolCall.type !== 'function') continue;

          const admitted = await admitToolCall(toolCall);
          if (admitted.kind === 'halt') {
            halt = admitted;
            haltIndex = index;
            break;
          }
          if (admitted.kind === 'filled') continue;
          ready.push(admitted.call);
        }

        // A model that only retries closed web tools spends a full call per
        // refusal; after MAX_GATED_TURNS such turns, end with a handoff.
        const gatedStreak = steering.endTurn(halt !== null, turn.toolCalls.length);
        if (gatedStreak !== null) {
          noteLimit(
            limitMessage(
              'limit.research',
              `${gatedStreak} turns in a row only retried closed web tools`,
            ),
          );
          return await completeAfterLimit();
        }

        const staged: Record<ToolStage, ReadyToolCall[]> = {
          skill: [],
          read: [],
          network: [],
          subagent: [],
          exec: [],
          mutate: [],
        };
        for (const call of ready) {
          staged[toolStage(call.toolName, call.tool)].push(call);
        }

        const runSerial = async (batch: ReadyToolCall[]) => {
          for (let i = 0; i < batch.length; i++) {
            const call = batch[i];
            if (!call) continue;
            const outcome = await executeReadyCall(
              call,
              batch.slice(i).map((item) => item.toolCall),
            );
            if (outcome !== 'ok') return outcome;
          }
          return 'ok' as const;
        };

        // I4 staging: skill → read → network → exec → mutate → subagent.
        // skill, read, and subagent run parallel (executeReadyBatch);
        // network, exec, mutate run serial (one at a time within stage).
        // Sub-agents go last so a review in the same turn sees this turn's edits.
        // Abort only on deferred|halted — never short-circuit on truthy 'ok'.
        let batchOutcome: 'ok' | 'deferred' | 'halted' = 'ok';
        for (const stageBatch of [staged.skill, staged.read] as const) {
          batchOutcome = await executeReadyBatch(stageBatch, []);
          if (batchOutcome !== 'ok') break;
        }
        if (batchOutcome === 'ok') {
          for (const stageBatch of [
            staged.network,
            staged.exec,
            staged.mutate,
          ] as const) {
            batchOutcome = await runSerial(stageBatch);
            if (batchOutcome !== 'ok') break;
          }
        }
        if (batchOutcome === 'ok') {
          batchOutcome = await executeReadyBatch(staged.subagent, []);
        }
        if (batchOutcome === 'deferred') {
          return finishChoiceSkipped();
        }
        if (batchOutcome === 'halted') {
          const skipDetail = lastLimitReason?.startsWith('limit.outcome:')
            ? limitMessage('limit.outcome', 'Skipped: tool call limit reached.')
            : SKIP_LIMIT_REACHED;
          await skipToolCalls(unansweredToolCalls(turn.toolCalls), skipDetail);
          return await completeAfterLimit();
        }
        if (halt) {
          return await finishHalt(halt, haltIndex, turn.toolCalls);
        }
        if (stopContent !== undefined) {
          return await finishRequestedStop(stopContent, turn.usage);
        }

        await manageResidency();
        maybeSteerProgress();
        maybeWarnBudget();
        emitTurnCompleted(iterations, turn.usage);
        continue;
      }

      // No tool calls — this is the final assistant response. durationMs is
      // this call; runDurationMs is the whole run the user waited for.
      await appendDurable(
        {
          role: 'assistant',
          content: turn.content ?? '',
        },
        { durationMs, runDurationMs: Date.now() - runStartedAt },
      );

      emit?.({
        type: 'assistant.completed',
        runId,
        messageId,
        content: turn.content,
        durationMs,
      });

      if (turn.finishReason === 'stop') {
        const result = turn.content ?? '';
        const openPlanWork = config.hasOpenPlanWork
          ? await config.hasOpenPlanWork()
          : false;

        if (openPlanWork && planWorkNudges < 1) {
          planWorkNudges += 1;
          messages.push({
            role: 'user',
            content: OPEN_PLAN_WORK_NUDGE,
          });
          emitTurnCompleted(iterations, turn.usage);
          continue;
        }

        if (openPlanWork) {
          noteLimit(limitMessage('limit.plan', 'Open plan todos remain'));
          emitTurnCompleted(iterations, turn.usage);
          emit?.({
            type: 'run.completed',
            runId,
            iterations,
            toolCalls: totalToolCalls,
            incomplete: true,
            ...(lastLimitReason ? { limitReason: lastLimitReason } : {}),
          });
          return {
            runId,
            content: result,
            iterations,
            toolCalls: totalToolCalls,
            status: 'incomplete',
            ...(lastLimitReason ? { limitReason: lastLimitReason } : {}),
          };
        }

        emitTurnCompleted(iterations, turn.usage);
        emit?.({
          type: 'run.completed',
          runId,
          iterations,
          toolCalls: totalToolCalls,
        });

        return {
          runId,
          content: result,
          iterations,
          toolCalls: totalToolCalls,
          status: 'completed',
        };
      }

      noteLimit(
        limitMessage(
          'limit.finish',
          `unexpected finish reason: ${turn.finishReason}`,
        ),
      );
      emitTurnCompleted(iterations, turn.usage);
      emit?.({
        type: 'run.completed',
        runId,
        iterations,
        toolCalls: totalToolCalls,
        incomplete: true,
        ...(lastLimitReason ? { limitReason: lastLimitReason } : {}),
      });

      return {
        runId,
        content: turn.content ?? '',
        iterations,
        toolCalls: totalToolCalls,
        status: 'incomplete',
        ...(lastLimitReason ? { limitReason: lastLimitReason } : {}),
      };
    }

    // Max iterations exceeded — finalize without tools.
    noteLimit(
      limitMessage(
        'limit.iterations',
        `max iterations exceeded (${limits.maxIterations})`,
      ),
    );

    return await completeAfterLimit();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Usage limit (e.g. Ollama 429 "session usage limit"): pause, not error.
    const capacityReason = signal?.aborted
      ? null
      : (config.capacity?.limitReasonFor(error) ?? null);

    // I1: close the gap on the error path. A throw mid-turn can leave
    // tool_call_ids without a durable tool row; the ledger is the truth.
    if (turnToolCalls.length > 0) {
      try {
        await skipToolCalls(
          unansweredToolCalls(turnToolCalls),
          capacityReason ? 'Skipped: account usage limit reached.' : 'Skipped: run errored.',
        );
      } catch {
        /* best-effort; the run is already failing */
      }
    }
    if (capacityReason) return finishPaused(capacityReason);

    trace({
      type: 'tool_error',
      runId,
      iteration: iterations,
      toolName: 'agent',
      error: message,
    });
    emit?.({ type: 'run.error', runId, error: message });

    return {
      runId,
      content: `Agent error: ${message}`,
      iterations,
      toolCalls: totalToolCalls,
      status: 'error',
    };
  }
}

/**
 * Finalize the answer after a limit without offering tools.
 * The steering prompt joins the live `messages` array only — it is loop
 * control flow, not a durable turn, so it must never hit onMessage.
 */
async function finalizeWithoutTools(
  modelCall: ModelCallFn,
  model: string,
  messages: ChatCompletionMessageParam[],
  onTextDelta: ((delta: string) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<ModelTurn> {
  // Doubles as the handoff the next run continues from (it is the last
  // assistant row in the ledger, and the Last run layer points at it).
  messages.push({
    role: 'user',
    content:
      'This run stopped at a limit; tools are off. If the request can be answered from the information above, answer it now and say what is uncertain. Otherwise write a short handoff for the next run: what is done (files changed, what was verified), what is left, and the exact next step.',
  });

  return modelCall(
    model,
    messages,
    {
      definitions: [],
      byName: new Map(),
    },
    onTextDelta,
    signal,
  );
}

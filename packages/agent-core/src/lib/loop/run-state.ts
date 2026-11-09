import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

import {
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_HARNESS_FLAGS,
  type AgentEventWithoutSeq,
  type ContextBudget,
  type HarnessFlags,
  type LedgerAppendMeta,
  type RunPosture,
  type RunUsage,
  type TokenUsage,
  type ToolOrigin,
  type ToolStage,
  type TraceEvent,
  type WebTrust,
} from '@agent/agent-models';

import { refreshContextReport } from '../context/assemble-context';
import { ReadDedupe } from '../context/residency';
import type { Tool, ToolRegistry } from '../tools/types';
import { createCallRecorder, type CallRecorder } from './call-record';
import { resolveLimits, type AgentLimits } from './limits';
import { ProgressSteering } from './progress-steering';
import { RepetitionGuard } from './repetition-guard';
import { RunBudget } from './run-budget';
import { preview, ToolCallRecord } from './tool-call-record';
import { toLedgerRecord } from './to-ledger-record';
import type { ModelCallFn, RunLoopConfig, RunLoopResult } from './types';
import { WebSourceStore } from './web-sources';

export type LoopTrace = (event: TraceEvent) => void;
export type LoopConfig = RunLoopConfig & { runId: string; trace: LoopTrace };
export type CoreResult = Omit<RunLoopResult, 'usage'>;

/**
 * Everything one run shares across its phases (model call, tool turn,
 * residency, steering, finish). Fixed fields are set once in
 * createRunState; the counters below them change as the run goes.
 */
export type RunState = {
  readonly config: LoopConfig;
  readonly modelCall: ModelCallFn;
  /** The live prompt. Phases append to it; the prefix before runStart is never rewritten. */
  readonly messages: ChatCompletionMessageParam[];
  readonly tools: ToolRegistry;
  readonly runId: string;
  readonly threadId: string;
  readonly signal: AbortSignal | undefined;
  readonly origin: ToolOrigin;
  readonly posture: RunPosture;
  readonly limits: AgentLimits;
  readonly runStartedAt: number;
  /** Index of the first message this run appends. */
  readonly runStart: number;
  readonly contextBudget: ContextBudget;
  readonly flags: HarnessFlags;
  /** Wraps config.trace and feeds turnSignals. */
  readonly trace: LoopTrace;
  /** Wraps config.emit and adds run spend to completion events. */
  readonly emit: ((event: AgentEventWithoutSeq) => void) | undefined;
  readonly budget: RunBudget;
  readonly steering: ProgressSteering;
  readonly guard: RepetitionGuard;
  readonly webSources: WebSourceStore;
  readonly recorder: CallRecorder | null;
  readonly record: ToolCallRecord;
  readonly readDedupe: ReadDedupe;
  /** load_skill results still resident in full: tool_call_id → name + iteration. */
  readonly skillLoads: Map<string, { name: string; iteration: number }>;
  /** Partial reads per path since its last edit. */
  readonly partialReadsByPath: Map<string, number>;
  /** What each web call made fetchable, until its row is written. */
  readonly trustByCall: Map<string, WebTrust>;
  /** Effort-router rule inputs, read from traced events; cleared after every model call. */
  readonly turnSignals: { toolError: boolean; wrote: boolean; nudged: boolean };

  iterations: number;
  totalToolCalls: number;
  planWorkNudges: number;
  lastLimitReason: string | undefined;
  advisorHinted: boolean;
  prefixHeavy: boolean;
  /** Set when a tool (sub-agent `report`) asks to end the run with this answer. */
  stopContent: string | undefined;
  /** Effort escalation fired: later calls use one rung above the baseline. */
  escalated: boolean;
  /** A successful edit with no run_terminal after it. */
  unverifiedEdit: boolean;
  /** The stop check already sent the run back once. */
  stopChecked: boolean;
};

export function createRunState(
  modelCall: ModelCallFn,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  config: LoopConfig,
  usage: RunUsage,
  runStartedAt: number,
): RunState {
  const limits = resolveLimits(config.limits);
  const turnSignals = { toolError: false, wrote: false, nudged: false };
  const trace: LoopTrace = (event) => {
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
  const webSources = new WebSourceStore({
    ...(config.putBlob ? { putBlob: config.putBlob } : {}),
    ...(config.readBlob ? { readBlob: config.readBlob } : {}),
  });
  webSources.seed(messages, config.webTrust);

  const state: RunState = {
    config,
    modelCall,
    messages,
    tools,
    runId: config.runId,
    threadId: config.threadId ?? 'unknown',
    signal: config.signal,
    origin: config.origin ?? 'chat',
    posture,
    limits,
    runStartedAt,
    runStart: messages.length,
    contextBudget: config.contextBudget ?? DEFAULT_CONTEXT_BUDGET,
    flags: config.flags ?? DEFAULT_HARNESS_FLAGS,
    trace,
    emit,
    budget,
    steering,
    guard: new RepetitionGuard(),
    webSources,
    recorder:
      config.recordCalls && config.putBlob ? createCallRecorder(config.putBlob) : null,
    // The record appends through the state, so its rows land in the same prompt and ledger.
    record: new ToolCallRecord(
      config.runId,
      emit,
      (message, meta) => appendDurable(state, message, meta),
      (toolCall) => argsPreviewOf(tools, toolCall),
    ),
    readDedupe: new ReadDedupe(),
    skillLoads: new Map(),
    partialReadsByPath: new Map(),
    trustByCall: new Map(),
    turnSignals,
    iterations: 0,
    totalToolCalls: 0,
    planWorkNudges: 0,
    lastLimitReason: undefined,
    advisorHinted: false,
    prefixHeavy: false,
    stopContent: undefined,
    escalated: false,
    unverifiedEdit: false,
    stopChecked: false,
  };
  return state;
}

/** A tool without a declared stage (e.g. a future MCP tool) is scheduled as mutate, the strictest class. */
export function toolStage(tool: Tool): ToolStage {
  return tool.stage ?? 'mutate';
}

/** The tool's own compact view of its arguments, so UI labels are not poisoned by truncated text. */
export function toolArgsPreview(tool: Tool | undefined, args: unknown): string {
  const shaped =
    tool?.previewArgs && args && typeof args === 'object' && !Array.isArray(args)
      ? tool.previewArgs(args as Record<string, unknown>)
      : args;
  return preview(shaped, 200);
}

/** Args preview for a call that never ran; unparsable arguments preview as empty. */
function argsPreviewOf(
  tools: ToolRegistry,
  toolCall: ChatCompletionMessageToolCall,
): string {
  if (toolCall.type !== 'function') return '';
  let args: unknown = {};
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    // keep the empty preview
  }
  return toolArgsPreview(tools.byName.get(toolCall.function.name), args);
}

/** A durable turn: joins the live prompt and the host ledger. */
export async function appendDurable(
  s: RunState,
  message: ChatCompletionMessageParam,
  meta?: LedgerAppendMeta,
): Promise<void> {
  s.messages.push(message);
  if (s.config.onMessage) {
    await s.config.onMessage(toLedgerRecord(message), meta);
  }
}

export function noteLimit(s: RunState, reason: string): void {
  s.lastLimitReason = reason;
  s.trace({
    type: 'limit',
    runId: s.runId,
    iteration: s.iterations,
    reason,
  });
  s.emit?.({ type: 'limit.hit', runId: s.runId, reason });
}

export function emitTurnCompleted(s: RunState, iteration: number, usage?: TokenUsage): void {
  const contextReport = s.config.contextReport
    ? refreshContextReport(s.config.contextReport, s.messages, s.tools, usage)
    : undefined;
  s.emit?.({
    type: 'turn.completed',
    runId: s.runId,
    iteration,
    ...(usage ? { usage } : {}),
    ...(contextReport ? { contextReport } : {}),
  });
}

const HARNESS_NOTE_PREFIX = '[Harness note, not from the user]';

/**
 * Loop control the model must read as the harness speaking, not the user
 * changing their mind. Joins the live prompt only, never the ledger.
 */
export function pushHarnessNote(s: RunState, text: string): void {
  s.messages.push({
    role: 'user',
    content: s.flags.harnessNotes ? `${HARNESS_NOTE_PREFIX} ${text}` : text,
  });
}

export function lastAssistantContent(s: RunState): string {
  for (let i = s.messages.length - 1; i >= 0; i--) {
    const message = s.messages[i];
    if (message?.role !== 'assistant') continue;
    return typeof message.content === 'string' ? message.content : '';
  }
  return '';
}

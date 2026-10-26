import type { ChoiceOption } from './choice.js';
import type { ContextReport } from './context.js';
import type { MemoryTarget } from './memory.js';
import type { ThreadPlan } from './plan.js';
import type { RunPosture, TokenUsage } from './run.js';

/**
 * AgentEvent — the server's streaming protocol to the client.
 *
 * Design rules:
 * - Every event carries `seq`, a monotonic per-run counter. This enables
 *   SSE reconnection with `?fromSeq=N` to replay missed events.
 * - Events are provider-agnostic. The UI never sees OpenAI chunk shapes.
 * - `assistant.delta` events carry text fragments as they arrive.
 * - Every assistant message ends with `assistant.completed` — tool-call turns
 *   included, emitted after the ledger append and before tool execution, so
 *   clients can settle each assistant message mid-run, not just at run end.
 * - Tool results in events carry a *preview* only (size-capped). The full
 *   payload is appended to the host ledger (blobs/ when large).
 */

export type AgentEvent =
  | RunStarted
  | TurnStarted
  | AssistantStarted
  | AssistantDelta
  | AssistantCompleted
  | ToolStarted
  | ToolCompleted
  | ToolFailed
  | ChoiceRequested
  | ChoiceResolved
  | MemoryUpdated
  | PlanUpdated
  | ContextCompacting
  | ContextCompacted
  | TurnCompleted
  | RunCompleted
  | RunSettled
  | RunError
  | LimitHit;

export interface RunStarted {
  seq: number;
  type: 'run.started';
  runId: string;
  threadId: string;
  mode: string;
  model: string;
  /** Host-applied Ask | Agent for this run. Composer chips are not this field. */
  posture: RunPosture;
  /** Heuristic size of the first request envelope (system + tools + messages). */
  estimatedPromptTokens?: number;
  /** Per-layer breakdown from assembleContext (M2). */
  contextReport?: ContextReport;
}

export interface TurnStarted {
  seq: number;
  type: 'turn.started';
  runId: string;
  iteration: number;
}

export interface AssistantStarted {
  seq: number;
  type: 'assistant.started';
  runId: string;
  messageId: string;
}

export interface AssistantDelta {
  seq: number;
  type: 'assistant.delta';
  runId: string;
  messageId: string;
  /** A text fragment. Append to the streaming message's content. */
  delta: string;
}

export interface AssistantCompleted {
  seq: number;
  type: 'assistant.completed';
  runId: string;
  messageId: string;
  /** The full final text content of the assistant message. */
  content: string;
  /** Wall-clock model-call + stream time; excludes tool execution (on ToolCompleted). */
  durationMs?: number;
}

export interface ToolStarted {
  seq: number;
  type: 'tool.started';
  runId: string;
  toolCallId: string;
  toolName: string;
  /** Truncated argument preview for UI display. */
  argsPreview: unknown;
}

export interface ToolCompleted {
  seq: number;
  type: 'tool.completed';
  runId: string;
  toolCallId: string;
  toolName: string;
  durationMs: number;
  /** Truncated result preview for UI display. Full result lives in the host ledger. */
  resultPreview: unknown;
}

export interface ToolFailed {
  seq: number;
  type: 'tool.failed';
  runId: string;
  toolCallId: string;
  error: string;
}

export interface TurnCompleted {
  seq: number;
  type: 'turn.completed';
  runId: string;
  iteration: number;
  /** Provider usage for the model call that finished this iteration. */
  usage?: TokenUsage;
  /** Layers rebuilt from the live prompt after this iteration. */
  contextReport?: ContextReport;
}

export interface RunCompleted {
  seq: number;
  type: 'run.completed';
  runId: string;
  iterations: number;
  toolCalls: number;
  /** True when the loop stopped on a limit, not a clean model stop. */
  incomplete?: boolean;
  /** Stable limit reason when incomplete (e.g. `limit.terminal: …`). */
  limitReason?: string;
}

export interface RunError {
  seq: number;
  type: 'run.error';
  runId: string;
  error: string;
}

export interface LimitHit {
  seq: number;
  type: 'limit.hit';
  runId: string;
  reason: string;
}

/** Run is paused until the client Continues or Skips this choice. */
export interface ChoiceRequested {
  seq: number;
  type: 'choice.requested';
  runId: string;
  choiceId: string;
  question: string;
  options: ChoiceOption[];
}

export interface ChoiceResolved {
  seq: number;
  type: 'choice.resolved';
  runId: string;
  choiceId: string;
  skipped: boolean;
  optionIds?: string[];
  text?: string;
}

/** Curated memory changed (applied or reverted). UI refetches files. */
export interface MemoryUpdated {
  seq: number;
  type: 'memory.updated';
  runId: string;
  opId: string;
  target: MemoryTarget;
  action: 'add' | 'patch' | 'remove' | 'revert';
}

/** Thread plan journal or todos changed. UI replaces the live plan card. */
export interface PlanUpdated {
  seq: number;
  type: 'plan.updated';
  runId: string;
  threadId: string;
  plan: ThreadPlan;
}

/** Host started M4 compaction after the model loop (still before run.settled). */
export interface ContextCompacting {
  seq: number;
  type: 'context.compacting';
  runId: string;
  threadId: string;
}

/**
 * Host wrote a context snapshot after a run (M4). Not a tool call —
 * UI shows a compaction step in the turn trail, not ToolStepList.
 */
export interface ContextCompacted {
  seq: number;
  type: 'context.compacted';
  runId: string;
  threadId: string;
  throughSeq: number;
  brief: string;
  summary: string;
  createdAt: string;
}

/**
 * Post-run host work finished (compaction attempted or skipped).
 * Client may clear ephemeral activeRun after this.
 */
export interface RunSettled {
  seq: number;
  type: 'run.settled';
  runId: string;
  /** True when the loop finished incomplete (limit / open plan / etc.). */
  incomplete?: boolean;
}

/** Union of event types for filtering. */
export type AgentEventType = AgentEvent['type'];

/**
 * An AgentEvent without the seq field — for emitters that assign seq.
 * Uses a distributive conditional so Omit applies to each union member,
 * preserving discriminated union narrowing on `type`.
 */
export type AgentEventWithoutSeq = AgentEvent extends infer E
  ? E extends { seq: number }
    ? Omit<E, 'seq'>
    : E
  : never;

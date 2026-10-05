/**
 * AgentEvent — the server's streaming protocol to the client.
 *
 * Design rules:
 * - Every event carries `seq`, a monotonic per-run counter. This enables
 *   SSE reconnection with `?fromSeq=N` to replay missed events.
 * - Events are provider-agnostic. The UI never sees OpenAI chunk shapes.
 * - `assistant.delta` events (streaming mode only) carry text fragments.
 *   In non-streaming mode the client receives `assistant.completed` directly.
 * - Tool results in events carry a *preview* only (size-capped). The full
 *   payload is stored client-side in IndexedDB `tool_calls`.
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
  | TurnCompleted
  | RunCompleted
  | RunError
  | LimitHit;

export interface RunStarted {
  seq: number;
  type: 'run.started';
  runId: string;
  threadId: string;
  mode: string;
  streaming: boolean;
  model: string;
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
  /** Truncated result preview for UI display. Full result in IndexedDB. */
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
}

export interface RunCompleted {
  seq: number;
  type: 'run.completed';
  runId: string;
  iterations: number;
  toolCalls: number;
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

/** Union of event types for filtering. */
export type AgentEventType = AgentEvent['type'];
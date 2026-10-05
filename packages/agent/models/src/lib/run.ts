import type { PendingToolCall } from './message.js';

/**
 * The execution instance of one user request and everything the agent
 * does to answer it. Lives in server memory for the run's lifetime;
 * the client persists a copy for history.
 */
export type RunStatus = 'running' | 'completed' | 'error' | 'interrupted';

export interface Run {
  id: string;
  threadId: string;
  triggerMessageId: string;
  status: RunStatus;
  iteration: number;
  toolCallCount: number;
  model: string;
  streaming: boolean;
  mode: string;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

/**
 * The completed output of one model call (one iteration of the loop),
 * regardless of streaming vs non-streaming transport.
 */
export interface ModelTurn {
  content: string;
  toolCalls: PendingToolCall[];
  finishReason: string | null;
}

/**
 * Context message in the OpenAI Chat Completions shape.
 * Kept as a structural type so we don't hard-depend on the OpenAI SDK here
 * (agent-models is a zero-dependency package).
 */
export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: PendingToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };
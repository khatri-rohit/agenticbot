import type { MessageAttachment, PendingToolCall } from './message.js';
import type { ThinkingValue } from './ollama-model.js';

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

/** Provider-reported token counts for one model call (when available). */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
}

/**
 * The completed output of one model call (one iteration of the loop),
 * regardless of streaming vs non-streaming transport.
 */
export interface ModelTurn {
  content: string;
  toolCalls: PendingToolCall[];
  finishReason: string | null;
  usage?: TokenUsage;
}

/**
 * Multimodal content parts for user messages (OpenAI Chat Completions shape).
 * Used when a user message carries image attachments alongside text.
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ChatContentPart[] }
  | {
      role: 'assistant';
      content: string | null;
      tool_calls?: PendingToolCall[];
    }
  | { role: 'tool'; tool_call_id: string; content: string };

/** POST /api/agent/run body. History is loaded from the host ledger. */
export type StartRunRequest = {
  threadId: string;
  /** New user turn to append. Omit when retrying the current ledger tail. */
  message?: {
    content: string;
    attachments?: MessageAttachment[];
  };
  /**
   * Keep ledger lines with seq <= this value; drop the rest before append/run.
   * Used for retry (keep last user) and edit (keep the turn before that user).
   */
  rewindThroughSeq?: number;
  streaming?: boolean;
  model?: string;
  /** When false, omit mode-allowed search tools; globals still apply. Default true. */
  webSearch?: boolean;
  thinking?: ThinkingValue;
  /** Frozen profile facts from client settings; injected into system prompt. */
  userPersona?: string;
};

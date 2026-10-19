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

/**
 * Per-run workspace posture. Not a ThreadKind / ModeName.
 * Ask = read-only tool pack; Agent = full workspace tools. Default agent.
 */
export type RunPosture = 'ask' | 'agent';

/** Workspace mutation tools. Ask must never register or execute these. */
export const ASK_STRIPPED_TOOLS = ['edit_file', 'run_terminal'] as const;

export function isAskStrippedTool(name: string): boolean {
  return (ASK_STRIPPED_TOOLS as readonly string[]).includes(name);
}

export function normalizeRunPosture(value: unknown): RunPosture {
  if (typeof value !== 'string') return 'agent';
  return value.trim().toLowerCase() === 'ask' ? 'ask' : 'agent';
}

/** Strip workspace write/exec tools when posture is Ask. */
export function applyPostureToTools(
  toolNames: string[],
  posture: RunPosture,
): string[] {
  if (posture !== 'ask') return toolNames;
  return toolNames.filter((name) => !isAskStrippedTool(name));
}

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
  /**
   * When true, route chat completions and /api/show to local Ollama
   * (`OLLAMA_LOCAL_BASE_URL`, default http://127.0.0.1:11434/v1).
   */
  local?: boolean;
  /** When false, omit mode-allowed search tools; globals still apply. Default true. */
  webSearch?: boolean;
  thinking?: ThinkingValue;
  /**
   * Workspace-only. Ask strips edit_file + run_terminal at the host allow-list.
   * Ignored for Home. Default agent.
   */
  posture?: RunPosture;
};

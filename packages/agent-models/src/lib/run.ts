import type { ChoiceRequest } from './choice.js';
import { parseContextWindowMode, type ContextWindowMode } from './context.js';
import {
  parseMessageAttachments,
  type MessageAttachment,
  type PendingToolCall,
} from './message.js';
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
 * Token spend for one run. `own` is this run's model calls; `children` is the
 * sum of every sub-agent run it spawned (already rolled up recursively).
 */
export interface RunUsage {
  own: UsageTotals;
  children: UsageTotals;
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  calls: number;
  /** Calls charged from the local estimate because the provider sent no usage. */
  estimatedCalls: number;
}

export function emptyRunUsage(): RunUsage {
  return {
    own: { promptTokens: 0, completionTokens: 0, calls: 0, estimatedCalls: 0 },
    children: { promptTokens: 0, completionTokens: 0, calls: 0, estimatedCalls: 0 },
  };
}

/** Own + children, for budgets and display. */
export function totalRunUsage(usage: RunUsage): UsageTotals {
  return {
    promptTokens: usage.own.promptTokens + usage.children.promptTokens,
    completionTokens:
      usage.own.completionTokens + usage.children.completionTokens,
    calls: usage.own.calls + usage.children.calls,
    estimatedCalls: usage.own.estimatedCalls + usage.children.estimatedCalls,
  };
}

/**
 * The completed output of one model call (one iteration of the loop),
 * regardless of transport.
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
 * Ask = read-only, answers questions. Plan = read-only, explores and writes
 * a plan for the user to approve (approving = switching to Agent).
 * Agent = full workspace tools. Default agent.
 */
export type RunPosture = 'ask' | 'plan' | 'agent';

/** Workspace mutation tools. Read-only postures never register or execute these. */
export const ASK_STRIPPED_TOOLS = ['edit_file', 'run_terminal'] as const;

export function isAskStrippedTool(name: string): boolean {
  return (ASK_STRIPPED_TOOLS as readonly string[]).includes(name);
}

/** Ask and Plan cannot edit files or run commands; the tool gate enforces it. */
export function isReadOnlyPosture(posture: RunPosture): boolean {
  return posture !== 'agent';
}

export function normalizeRunPosture(value: unknown): RunPosture {
  if (typeof value !== 'string') return 'agent';
  const posture = value.trim().toLowerCase();
  return posture === 'ask' || posture === 'plan' ? posture : 'agent';
}

/** Strip workspace write/exec tools in a read-only posture. */
export function applyPostureToTools(
  toolNames: string[],
  posture: RunPosture,
): string[] {
  if (!isReadOnlyPosture(posture)) return toolNames;
  return toolNames.filter((name) => !isAskStrippedTool(name));
}

/**
 * A run in progress as `GET /ledger` reports it, so a reloaded page can show
 * and steer it without the stream's opening events.
 */
export type ActiveRun = {
  runId: string;
  model: string;
  posture: RunPosture;
  startedAt: string;
  /** Choices the run is paused on. */
  pendingChoices: (ChoiceRequest & { choiceId: string })[];
};

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
  /** User-requested catalog names from `/` picks. Bodies load for this send. */
  skills?: {
    requested?: string[];
  };
  /** Persisted on the thread when present; later runs and compaction reuse it. */
  contextWindowMode?: ContextWindowMode;
};

const isOptional = (value: unknown, type: 'string' | 'boolean') =>
  value === undefined || typeof value === type;

/** Trust boundary for `POST /run`: the parsed request, or why it was rejected. */
export function parseStartRunRequest(raw: unknown): StartRunRequest | string {
  if (!raw || typeof raw !== 'object') return 'request body must be an object';
  const body = raw as Record<string, unknown>;
  if (typeof body.threadId !== 'string' || !body.threadId) {
    return 'threadId is required';
  }
  if (
    !isOptional(body.model, 'string') ||
    !isOptional(body.local, 'boolean') ||
    !isOptional(body.webSearch, 'boolean')
  ) {
    return 'model must be a string; local and webSearch must be booleans';
  }
  if (
    body.thinking !== undefined &&
    typeof body.thinking !== 'boolean' &&
    typeof body.thinking !== 'string'
  ) {
    return 'thinking must be a boolean or a string';
  }
  if (
    body.rewindThroughSeq !== undefined &&
    !(Number.isInteger(body.rewindThroughSeq) && (body.rewindThroughSeq as number) >= 0)
  ) {
    return 'rewindThroughSeq must be a non-negative integer';
  }
  const requested = (body.skills as { requested?: unknown } | undefined)?.requested;
  if (
    requested !== undefined &&
    !(Array.isArray(requested) && requested.every((name) => typeof name === 'string'))
  ) {
    return 'skills.requested must be a string array';
  }

  let message: StartRunRequest['message'];
  if (body.message !== undefined) {
    const sent = body.message as { content?: unknown; attachments?: unknown } | null;
    if (!sent || typeof sent.content !== 'string') {
      return 'message.content must be a string';
    }
    const attachments = parseMessageAttachments(sent.attachments);
    if (typeof attachments === 'string') return attachments;
    message = {
      content: sent.content,
      ...(attachments.length > 0 ? { attachments } : {}),
    };
  }

  const contextWindowMode = parseContextWindowMode(body.contextWindowMode);
  return {
    threadId: body.threadId,
    ...(message ? { message } : {}),
    ...(body.rewindThroughSeq !== undefined
      ? { rewindThroughSeq: body.rewindThroughSeq as number }
      : {}),
    ...(body.model !== undefined ? { model: body.model as string } : {}),
    ...(body.local !== undefined ? { local: body.local as boolean } : {}),
    ...(body.webSearch !== undefined ? { webSearch: body.webSearch as boolean } : {}),
    ...(body.thinking !== undefined ? { thinking: body.thinking as ThinkingValue } : {}),
    posture: normalizeRunPosture(body.posture),
    ...(requested ? { skills: { requested: requested as string[] } } : {}),
    ...(contextWindowMode ? { contextWindowMode } : {}),
  };
}

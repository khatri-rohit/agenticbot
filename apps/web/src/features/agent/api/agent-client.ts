import type {
  AgentEvent,
  ChatMessage,
  MessageAttachment,
  OllamaModelConfig,
  StartRunRequest,
  ThinkingValue,
} from '@org/agent-models';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3333';

/* ---------- Pending message (cross-route handoff) ---------- */

const PENDING_MSG_KEY = 'agenticbot:pendingMessage';

export type ComposerOptions = {
  streaming: boolean;
  webSearch: boolean;
  model: string;
  /** Model-specific thinking: false / true / effort name from `/api/show`. */
  thinking?: ThinkingValue;
};

export type PendingMessage = {
  content: string;
  streaming: boolean;
  webSearch?: boolean;
  model?: string;
  thinking?: ThinkingValue;
  attachments?: MessageAttachment[];
};

/**
 * Stash a message for the chat page to send on mount.
 * Returns false when sessionStorage rejects the payload (quota / private mode).
 */
export function stashPendingMessage(msg: PendingMessage): boolean {
  try {
    sessionStorage.setItem(PENDING_MSG_KEY, JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

/** Read and clear the stashed message. Returns null if none. */
export function takePendingMessage(): PendingMessage | null {
  const raw = sessionStorage.getItem(PENDING_MSG_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(PENDING_MSG_KEY);
  return JSON.parse(raw) as PendingMessage;
}

/**
 * Start an agent run. History is owned by the API ledger.
 */
export async function startRun(
  threadId: string,
  options: {
    message?: { content: string; attachments?: MessageAttachment[] };
    rewindThroughSeq?: number;
    streaming?: boolean;
    model?: string;
    webSearch?: boolean;
    thinking?: ThinkingValue;
    userPersona?: string;
  } = {},
): Promise<string> {
  const body: StartRunRequest = {
    threadId,
    message: options.message,
    rewindThroughSeq: options.rewindThroughSeq,
    streaming: options.streaming ?? true,
    model: options.model,
    webSearch: options.webSearch,
    thinking: options.thinking,
    userPersona: options.userPersona,
  };

  const res = await fetch(`${API_BASE}/api/agent/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to start run: ${res.status}`);
  }

  const { runId } = await res.json();
  return runId;
}

/**
 * Subscribe to a run's SSE event stream.
 * Replays events from fromSeq, then streams live events.
 *
 * Returns an unsubscribe function.
 */
export function subscribeRun(
  runId: string,
  fromSeq: number,
  onEvent: (event: AgentEvent) => void,
  onError?: (error: Error) => void,
): () => void {
  const url = `${API_BASE}/api/agent/run/${runId}/events?fromSeq=${fromSeq}`;
  const es = new EventSource(url);

  es.onmessage = (e) => {
    try {
      const event = JSON.parse(e.data) as AgentEvent;
      onEvent(event);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };

  es.addEventListener('done', () => {
    es.close();
  });

  es.onerror = () => {
    onError?.(new Error('SSE connection lost'));
    es.close();
  };

  return () => {
    es.close();
  };
}

export async function fetchOllamaModelConfig(
  model: string,
): Promise<OllamaModelConfig> {
  const res = await fetch(
    `${API_BASE}/api/agent/models/config?model=${encodeURIComponent(model)}`,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to load model config: ${res.status}`);
  }
  return res.json() as Promise<OllamaModelConfig>;
}

export type ContextEstimateResponse = {
  estimatedPromptTokens: number;
  contextLength: number | null;
  source: 'estimate';
};

/** Server-side heuristic for the next request envelope (system + tools + messages). */
export async function fetchContextEstimate(options: {
  messages: ChatMessage[];
  model?: string;
  webSearch?: boolean;
  userPersona?: string;
}): Promise<ContextEstimateResponse> {
  const res = await fetch(`${API_BASE}/api/agent/context/estimate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: options.messages,
      model: options.model,
      webSearch: options.webSearch,
      userPersona: options.userPersona,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to estimate context: ${res.status}`);
  }
  return res.json() as Promise<ContextEstimateResponse>;
}

export async function cancelRun(runId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/agent/run/${runId}/cancel`, {
    method: 'POST',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to cancel run: ${res.status}`);
  }
}

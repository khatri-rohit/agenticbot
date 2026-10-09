import type {
  AgentEvent,
  ChatMessage,
  OllamaModelConfig,
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
};

/** Stash a message for the chat page to send on mount. */
export function stashPendingMessage(msg: PendingMessage): void {
  sessionStorage.setItem(PENDING_MSG_KEY, JSON.stringify(msg));
}

/** Read and clear the stashed message. Returns null if none. */
export function takePendingMessage(): PendingMessage | null {
  const raw = sessionStorage.getItem(PENDING_MSG_KEY);
  if (!raw) return null;
  sessionStorage.removeItem(PENDING_MSG_KEY);
  return JSON.parse(raw) as PendingMessage;
}

/**
 * Start an agent run. Returns the runId.
 * The server is stateless — we send the full message context.
 */
export async function startRun(
  threadId: string,
  messages: ChatMessage[],
  options: {
    streaming?: boolean;
    model?: string;
    webSearch?: boolean;
    thinking?: ThinkingValue;
  } = {},
): Promise<string> {
  const allowedTools = options.webSearch === false ? [] : ['web_search'];

  const res = await fetch(`${API_BASE}/api/agent/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threadId,
      messages,
      streaming: options.streaming ?? true,
      model: options.model,
      allowedTools,
      thinking: options.thinking,
    }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to start run: ${res.status}`);
  }

  const { runId } = await res.json();
  return runId;
}

/**
 * Enqueue a title generation job for a thread's first message.
 * Returns the jobId for polling.
 */
export async function enqueueTitle(
  threadId: string,
  firstMessage: string,
): Promise<string> {
  const res = await fetch(`${API_BASE}/api/agent/title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, firstMessage }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to enqueue title: ${res.status}`);
  }

  const { jobId } = await res.json();
  return jobId;
}

/**
 * Poll a title generation job.
 * Returns the title string when completed, or null if still pending.
 */
export async function pollTitle(
  jobId: string,
): Promise<
  | { status: 'completed'; title: string }
  | { status: 'pending' }
  | { status: 'failed' }
> {
  const res = await fetch(`${API_BASE}/api/agent/title/${jobId}`);
  if (!res.ok) return { status: 'failed' };
  return res.json();
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

export async function cancelRun(runId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/agent/run/${runId}/cancel`, {
    method: 'POST',
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to cancel run: ${res.status}`);
  }
}

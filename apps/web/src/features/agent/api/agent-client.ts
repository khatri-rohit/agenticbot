import type {
  AgentEvent,
  ContextReport,
  MemoryCaps,
  MemoryFiles,
  MemoryOp,
  MessageAttachment,
  OllamaEndpoint,
  OllamaListedModel,
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
  /** Route chat + discovery to local Ollama daemon. */
  local?: boolean;
  /** Model-specific thinking: false / true / effort name from `/api/show`. */
  thinking?: ThinkingValue;
};

export type PendingMessage = {
  content: string;
  streaming: boolean;
  webSearch?: boolean;
  model?: string;
  local?: boolean;
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
    local?: boolean;
    webSearch?: boolean;
    thinking?: ThinkingValue;
  } = {},
): Promise<string> {
  const body: StartRunRequest = {
    threadId,
    message: options.message,
    rewindThroughSeq: options.rewindThroughSeq,
    streaming: options.streaming ?? true,
    model: options.model,
    local: options.local,
    webSearch: options.webSearch,
    thinking: options.thinking,
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
  endpoint: OllamaEndpoint = 'cloud',
): Promise<OllamaModelConfig> {
  const params = new URLSearchParams({ model, endpoint });
  const res = await fetch(
    `${API_BASE}/api/agent/models/config?${params.toString()}`,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to load model config: ${res.status}`);
  }
  return res.json() as Promise<OllamaModelConfig>;
}

export type LocalOllamaModelsResponse = {
  endpoint: OllamaEndpoint;
  models: OllamaListedModel[];
};

/** Discover models installed on the API host's local Ollama (`/api/tags`). */
export async function fetchLocalOllamaModels(): Promise<LocalOllamaModelsResponse> {
  const res = await fetch(`${API_BASE}/api/agent/models?endpoint=local`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to list local models: ${res.status}`);
  }
  return res.json() as Promise<LocalOllamaModelsResponse>;
}

export type ContextEstimateResponse = {
  estimatedPromptTokens: number;
  contextLength: number | null;
  source: 'estimate';
  contextReport: ContextReport;
};

/** Same assembleContext path as /run: host ledger + memory + optional draft. */
export async function fetchContextEstimate(options: {
  threadId?: string;
  draft?: string;
  attachments?: MessageAttachment[];
  model?: string;
  local?: boolean;
  webSearch?: boolean;
}): Promise<ContextEstimateResponse> {
  const res = await fetch(`${API_BASE}/api/agent/context/estimate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threadId: options.threadId,
      draft: options.draft,
      attachments: options.attachments,
      model: options.model,
      local: options.local,
      webSearch: options.webSearch,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to estimate context: ${res.status}`);
  }
  return res.json() as Promise<ContextEstimateResponse>;
}

export type MemoryResponse = {
  files: MemoryFiles;
  ops: MemoryOp[];
  caps: MemoryCaps;
};

export async function fetchMemory(): Promise<MemoryResponse> {
  const res = await fetch(`${API_BASE}/api/agent/memory`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to load memory: ${res.status}`);
  }
  return res.json() as Promise<MemoryResponse>;
}

export async function saveUserMemory(
  user: string,
  threadId?: string,
): Promise<MemoryOp> {
  const res = await fetch(`${API_BASE}/api/agent/memory`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, threadId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to save profile: ${res.status}`);
  }
  const { op } = (await res.json()) as { op: MemoryOp };
  return op;
}

export async function revertMemoryOp(opId: string): Promise<MemoryOp> {
  const res = await fetch(`${API_BASE}/api/agent/memory/revert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ opId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Failed to revert memory: ${res.status}`);
  }
  const { op } = (await res.json()) as { op: MemoryOp };
  return op;
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

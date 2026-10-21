import type {
  AgentEvent,
  ApprovalDecision,
  ContextReport,
  MemoryCaps,
  MemoryFiles,
  MemoryOp,
  MessageAttachment,
  OllamaEndpoint,
  OllamaListedModel,
  OllamaModelConfig,
  RunPosture,
  StartRunRequest,
  ThinkingValue,
} from '@desk/agent-models';
import { normalizeRunPosture } from '@desk/agent-models';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3333';

/* ---------- Pending message (cross-route handoff) ---------- */

const PENDING_MSG_KEY = 'desk:pendingMessage';

export type ComposerOptions = {
  webSearch: boolean;
  model: string;
  /** Route chat + discovery to local Ollama daemon. */
  local?: boolean;
  /** Model-specific thinking: false / true / effort name from `/api/show`. */
  thinking?: ThinkingValue;
  /** Workspace-only Ask | Agent. Default agent. Ignored on Home. */
  posture?: RunPosture;
};

export type PendingMessage = {
  content: string;
  webSearch?: boolean;
  model?: string;
  local?: boolean;
  thinking?: ThinkingValue;
  posture?: RunPosture;
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
    model?: string;
    local?: boolean;
    webSearch?: boolean;
    thinking?: ThinkingValue;
    posture?: RunPosture;
  } = {},
): Promise<string> {
  const body: StartRunRequest = {
    threadId,
    message: options.message,
    rewindThroughSeq: options.rewindThroughSeq,
    model: options.model,
    local: options.local,
    webSearch: options.webSearch,
    thinking: options.thinking,
    posture: normalizeRunPosture(options.posture),
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
  let closed = false;
  let cursor = fromSeq;
  let retries = 0;
  let source: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closed) return;
    const url = `${API_BASE}/api/agent/run/${runId}/events?fromSeq=${cursor}`;
    const es = new EventSource(url);
    source = es;

    es.onmessage = (e) => {
      retries = 0;
      try {
        const event = JSON.parse(e.data) as AgentEvent;
        if (typeof event.seq === 'number') {
          cursor = Math.max(cursor, event.seq);
        }
        onEvent(event);
        if (event.type === 'run.settled' || event.type === 'run.error') {
          closed = true;
          es.close();
        }
      } catch (err) {
        onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };

    es.addEventListener('done', () => {
      closed = true;
      es.close();
    });

    es.onerror = () => {
      es.close();
      if (closed) return;
      retries += 1;
      if (retries > 8) {
        onError?.(new Error('SSE connection lost'));
        return;
      }
      const delay = Math.min(1000 * 2 ** (retries - 1), 8000);
      reconnectTimer = setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    source?.close();
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
  posture?: RunPosture;
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
      posture: normalizeRunPosture(options.posture),
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

export async function resolveApproval(
  runId: string,
  body: {
    approvalId: string;
    decision: ApprovalDecision;
    optionId?: string;
  },
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/agent/run/${runId}/approval`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      payload.error ?? `Failed to resolve approval: ${res.status}`,
    );
  }
}

export async function resolveChoice(
  runId: string,
  body:
    | { choiceId: string; skipped: true }
    | { choiceId: string; optionIds: string[]; text?: string },
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/agent/run/${runId}/choice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(
      payload.error ?? `Failed to resolve choice: ${res.status}`,
    );
  }
}

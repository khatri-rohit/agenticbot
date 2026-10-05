import type { AgentEvent, ChatMessage } from '@org/agent-models';

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3333';

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
  } = {},
): Promise<string> {
  const res = await fetch(`${API_BASE}/api/agent/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      threadId,
      messages,
      streaming: options.streaming ?? true,
      model: options.model,
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
import type { ThinkingValue, ThreadLastRun } from '@agent/agent-models';

/**
 * How waiting for a run ended. `cancelled`: `run.settled` with `cancelled`.
 * `gone`: the API no longer holds the run, or the stream closed without a
 * settle; the ledger is the truth either way.
 */
export type RunEnd = 'settled' | 'cancelled' | 'gone' | 'timeout';

/**
 * The few API calls a trial needs (base `http://localhost:<port>/api/agent`).
 * Trials go through the real entry point (G2); nothing here calls the loop.
 */
export class ApiClient {
  constructor(private readonly base: string) {}

  private async json<T>(method: string, route: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}${route}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${route} → ${response.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  createThread(input: { workspaceRoot: string; model: string; title: string }): Promise<{ id: string }> {
    return this.json('POST', '/threads', { kind: 'workspace', ...input });
  }

  deleteThread(id: string): Promise<unknown> {
    return this.json('DELETE', `/threads/${id}`);
  }

  startRun(input: {
    threadId: string;
    content: string;
    model: string;
    posture: 'agent' | 'ask';
    /** Omitted: the model default. `'auto'`: System 1 picks per iteration (enforce mode only). */
    thinking?: ThinkingValue;
  }): Promise<{ runId: string }> {
    return this.json('POST', '/run', {
      threadId: input.threadId,
      message: { content: input.content },
      model: input.model,
      posture: input.posture,
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
      webSearch: true,
      contextWindowMode: 'default',
    });
  }

  cancelRun(runId: string): Promise<unknown> {
    return this.json('POST', `/run/${runId}/cancel`);
  }

  ledger(threadId: string): Promise<{ lastRun?: ThreadLastRun; activeRunId?: string }> {
    return this.json('GET', `/threads/${threadId}/ledger`);
  }

  /** `null` when the API has no OLLAMA_API_KEY (local models: no capacity gate). */
  async balance(): Promise<unknown | null> {
    try {
      return await this.json('GET', '/usage/balance');
    } catch (error) {
      if (error instanceof Error && error.message.includes('→ 404')) return null;
      throw error;
    }
  }

  /**
   * Wait for a run to settle: read its SSE stream until `run.settled` or
   * `event: done` (the run had already settled). Every run ends with
   * `run.settled`, so its workspace and ledger are final after it; `run.error`
   * is only the cancel notice before it. Times out after `timeoutMs`.
   */
  async waitForRun(runId: string, timeoutMs: number): Promise<RunEnd> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.base}/run/${runId}/events`, { signal: controller.signal });
      if (response.status === 404) return 'gone';
      if (!response.ok || !response.body) throw new Error(`events ${runId} → ${response.status}`);
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let split: number;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          if (/^event: done$/m.test(frame)) return 'settled';
          const data = frame.match(/^data: (.*)$/m)?.[1];
          if (!data) continue;
          const event = JSON.parse(data) as { type?: string; cancelled?: boolean };
          if (event.type === 'run.settled') return event.cancelled ? 'cancelled' : 'settled';
        }
      }
      return 'gone';
    } catch (error) {
      if (controller.signal.aborted) return 'timeout';
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}

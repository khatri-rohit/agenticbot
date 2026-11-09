import type { LedgerResponse, StartRunRequest, ThinkingValue, ThreadLastRun } from '@agent/agent-models';

/** How often a trial reads the ledger while it waits for its run. */
const POLL_MS = 2_000;

/**
 * The few API calls a trial needs (base `http://localhost:<port>/api/agent`).
 * Trials go through the real entry point (G2); nothing here calls the loop.
 */
export class ApiClient {
  constructor(
    private readonly base: string,
    private readonly pollMs = POLL_MS,
  ) {}

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
    posture: 'agent' | 'ask' | 'plan';
    /** Omitted: the model default. `'auto'`: System 1 picks per iteration (enforce mode only). */
    thinking?: ThinkingValue;
  }): Promise<{ runId: string }> {
    const body: StartRunRequest = {
      threadId: input.threadId,
      message: { content: input.content },
      model: input.model,
      posture: input.posture,
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
      webSearch: true,
      contextWindowMode: 'default',
    };
    return this.json('POST', '/run', body);
  }

  /** A run that already settled answers 404: that is fine, there is nothing left to stop. */
  async cancelRun(runId: string): Promise<void> {
    await this.json('POST', `/run/${runId}/cancel`).catch(() => undefined);
  }

  ledger(threadId: string): Promise<LedgerResponse> {
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
   * Wait until `runId` has settled and return its last-run, or null after
   * `timeoutMs`. The API shows a run's last-run only once the run has fully
   * settled (workspace and ledger final), so "the thread's last-run is this
   * run" is the whole signal: no stream to drop, no race with post-run work.
   * Nobody answers a choice in a trial, so a run paused on one is skipped
   * (the run then ends with a summary of the options).
   */
  async settledLastRun(threadId: string, runId: string, timeoutMs: number): Promise<ThreadLastRun | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ledger = await this.ledger(threadId);
      if (ledger.lastRun?.runId === runId) return ledger.lastRun;
      if (ledger.activeRun?.runId === runId) {
        for (const choice of ledger.activeRun.pendingChoices) {
          // 404: answered or gone meanwhile.
          await this.json('POST', `/run/${runId}/choice`, { choiceId: choice.choiceId, skipped: true }).catch(
            () => undefined,
          );
        }
      }
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }
}

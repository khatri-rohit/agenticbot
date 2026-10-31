import { execSync } from 'node:child_process';

/**
 * Minimal HTTP client for the eval runner. Talks to a running API
 * (AGENT_HOME=evals/home) via POST /threads, POST /run, SSE wait, and
 * GET /usage/balance. Never calls runLoop directly.
 */

export type ApiClient = {
  createThread(opts: { model: string; workspaceRoot?: string }): Promise<{ threadId: string }>;
  startRun(opts: {
    threadId: string;
    prompt: string;
    posture: string;
  }): Promise<{ runId: string }>;
  waitForRun(threadId: string, runId: string): Promise<{ status: string; limitReason?: string }>;
  getBalance(): Promise<{ percent: number; paused: boolean }>;
};

function apiBase(): string {
  return process.env.EVAL_API_URL ?? 'http://localhost:3001';
}

function curlJson(method: string, path: string, body?: unknown): string {
  const url = `${apiBase()}${path}`;
  const args = ['-s', '-X', method, url];
  if (body) {
    args.push('-H', 'Content-Type: application/json', '-d', JSON.stringify(body));
  }
  return execSync(`curl ${args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ')}`, {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function createApiClient(): ApiClient {
  return {
    async createThread(opts) {
      const raw = curlJson('POST', '/api/agent/threads', {
        model: opts.model,
        ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}),
      });
      const res = JSON.parse(raw) as { threadId: string };
      return res;
    },

    async startRun(opts) {
      const raw = curlJson('POST', '/api/agent/run', {
        threadId: opts.threadId,
        prompt: opts.prompt,
        posture: opts.posture,
      });
      const res = JSON.parse(raw) as { runId: string };
      return res;
    },

    async waitForRun(threadId, runId) {
      // Poll last-run.json via the API's thread status endpoint.
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        const raw = curlJson('GET', `/api/agent/threads/${threadId}/runs/${runId}`);
        const res = JSON.parse(raw) as { status: string; limitReason?: string };
        if (res.status === 'complete' || res.status === 'incomplete' || res.status === 'error') {
          return res;
        }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      return { status: 'timeout' };
    },

    async getBalance() {
      try {
        const raw = curlJson('GET', '/api/agent/usage/balance');
        const res = JSON.parse(raw) as { percent: number; paused: boolean };
        return res;
      } catch {
        return { percent: 100, paused: false };
      }
    },
  };
}
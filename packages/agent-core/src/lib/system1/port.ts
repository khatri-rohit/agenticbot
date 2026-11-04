import type {
  System1Fallback,
  System1FallbackKind,
  System1Mode,
  System1Question,
  System1RunReport,
  System1Scores,
  System1Site,
} from '@agent/agent-models';

import { callSystem1, type System1ClientConfig } from './client';
import type { System1Health } from './health';

/**
 * What the loop sees of System 1. `ask` never throws and never blocks past
 * the client timeout: null means "no opinion", and the caller uses its
 * deterministic default (today's behaviour).
 */
export interface System1Port {
  readonly mode: Exclude<System1Mode, 'off'>;
  ask(
    site: System1Site,
    state: string,
    questions: Record<string, System1Question>,
    ctx: { iteration: number; signal?: AbortSignal },
  ): Promise<System1Scores | null>;
  /** Record a fallback found by a policy (e.g. inconsistent scores). */
  note(site: System1Site, kind: System1FallbackKind, iteration: number, detail: string): void;
  /** A decision changed what was sent to the main model. */
  markApplied(): void;
  /** Track work that finishes after the call that started it (shadow decisions). */
  track(work: Promise<unknown>): void;
  /** Resolves once tracked work has settled. Never rejects. */
  settle(): Promise<void>;
  /** Null when System 1 was never consulted this run. */
  report(): System1RunReport | null;
}

const DETAIL_MAX = 200;
/**
 * Longest wait for a free slot. Kept short and separate from the call
 * timeout: with parallel runs, a full-timeout queue wait plus the call
 * itself would double the delay before a step falls back.
 */
const SLOT_WAIT_MS = 250;

/** Run-scoped tally of calls, latencies and fallbacks. */
export class System1Recorder {
  private calls = 0;
  private applied = 0;
  private readonly latencies: number[] = [];
  private readonly fallbacks = new Map<string, System1Fallback>();

  constructor(private readonly mode: Exclude<System1Mode, 'off'>) {}

  call(latencyMs: number): void {
    this.calls++;
    this.latencies.push(latencyMs);
  }

  markApplied(): void {
    this.applied++;
  }

  fallback(site: System1Site, kind: System1FallbackKind, iteration: number, detail: string): void {
    const key = `${site}:${kind}`;
    const existing = this.fallbacks.get(key);
    if (existing) {
      existing.count++;
      return;
    }
    this.fallbacks.set(key, {
      site,
      kind,
      count: 1,
      firstIteration: iteration,
      detail: detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX)}…` : detail,
    });
  }

  report(): System1RunReport | null {
    if (this.calls === 0 && this.fallbacks.size === 0) return null;
    return {
      mode: this.mode,
      calls: this.calls,
      applied: this.applied,
      fallbacks: [...this.fallbacks.values()],
      latencyMs: percentiles(this.latencies),
    };
  }
}

function percentiles(values: number[]): { p50: number; p95: number } | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return { p50: at(0.5), p95: at(0.95) };
}

export type System1PortOptions = {
  client: System1ClientConfig;
  health: System1Health;
  mode: Exclude<System1Mode, 'off'>;
  /** Total System 1 wall time this run may spend before every call is skipped. */
  runBudgetMs: number;
  fetchImpl?: typeof fetch;
};

/** One port per run: shared health, own recorder and time budget. */
export function createSystem1Port(options: System1PortOptions): System1Port {
  const { client, health, mode, runBudgetMs, fetchImpl } = options;
  const recorder = new System1Recorder(mode);
  const pending = new Set<Promise<unknown>>();
  let spentMs = 0;

  async function ask(
    site: System1Site,
    state: string,
    questions: Record<string, System1Question>,
    ctx: { iteration: number; signal?: AbortSignal },
  ): Promise<System1Scores | null> {
    try {
      if (ctx.signal?.aborted) return null;
      if (spentMs >= runBudgetMs) {
        recorder.fallback(site, 'budget_exhausted', ctx.iteration, `run spent ${spentMs}ms of ${runBudgetMs}ms on System 1`);
        return null;
      }
      if (!health.admit()) {
        recorder.fallback(site, 'breaker_open', ctx.iteration, 'skipped after repeated failures');
        return null;
      }
      const waitStarted = Date.now();
      const release = await health.acquire(Math.min(SLOT_WAIT_MS, client.timeoutMs));
      if (!release) {
        health.release();
        spentMs += Date.now() - waitStarted;
        recorder.fallback(site, 'busy', ctx.iteration, `no free slot within ${SLOT_WAIT_MS}ms`);
        return null;
      }
      try {
        const result = await callSystem1(client, state, questions, ctx.signal, fetchImpl);
        spentMs += Date.now() - waitStarted;
        if (result.ok) {
          health.success();
          recorder.call(result.latencyMs);
          return result.scores;
        }
        if (result.kind === 'cancelled') {
          health.release();
          return null;
        }
        recorder.call(result.latencyMs);
        if (result.kind === 'bad_response') health.badResponse();
        else if (result.kind === 'http_error' && /^HTTP 4/.test(result.detail)) health.badResponse();
        else health.failure();
        recorder.fallback(site, result.kind, ctx.iteration, result.detail);
        return null;
      } finally {
        release();
      }
    } catch (error) {
      health.release();
      recorder.fallback(site, 'internal', ctx.iteration, error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  return {
    mode,
    ask,
    note: (site, kind, iteration, detail) => recorder.fallback(site, kind, iteration, detail),
    markApplied: () => recorder.markApplied(),
    track(work) {
      const settled = work.then(
        () => undefined,
        () => undefined,
      );
      pending.add(settled);
      void settled.then(() => pending.delete(settled));
    },
    async settle() {
      while (pending.size > 0) await Promise.all([...pending]);
    },
    report: () => recorder.report(),
  };
}

import { RUN_CANCELLED_REASON, RUN_INTERRUPTED_REASON } from './limits.js';
import type { System1RunReport } from './system1.js';

/**
 * Durable summary of the last finished run on a thread.
 * Ledger-over-stream: survives refresh when SSE limit.hit is gone.
 */
export type ThreadLastRunStatus = 'completed' | 'incomplete' | 'error';

export type ThreadLastRun = {
  runId: string;
  status: ThreadLastRunStatus;
  incomplete: boolean;
  iterations: number;
  toolCalls: number;
  /** Stable `limit.*` reason when incomplete due to a gate. */
  limitReason?: string;
  finishedAt: string;
  /** System 1 fallbacks of that run (only when it had any). */
  system1?: System1RunReport;
};

export function parseThreadLastRun(raw: unknown): ThreadLastRun | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.runId !== 'string' || !record.runId) return null;
  if (
    record.status !== 'completed' &&
    record.status !== 'incomplete' &&
    record.status !== 'error'
  ) {
    return null;
  }
  if (typeof record.incomplete !== 'boolean') return null;
  if (typeof record.iterations !== 'number') return null;
  if (typeof record.toolCalls !== 'number') return null;
  if (typeof record.finishedAt !== 'string') return null;
  return {
    runId: record.runId,
    status: record.status,
    incomplete: record.incomplete,
    iterations: record.iterations,
    toolCalls: record.toolCalls,
    finishedAt: record.finishedAt,
    ...(typeof record.limitReason === 'string'
      ? { limitReason: record.limitReason }
      : {}),
    ...(isSystem1Report(record.system1) ? { system1: record.system1 } : {}),
  };
}

function isSystem1Report(raw: unknown): raw is System1RunReport {
  if (!raw || typeof raw !== 'object') return false;
  const report = raw as Record<string, unknown>;
  return (
    (report.mode === 'shadow' || report.mode === 'enforce') &&
    typeof report.calls === 'number' &&
    Array.isArray(report.fallbacks)
  );
}

/** How a run ended. `interrupted`: the server stopped before the run finished. */
export type RunOutcome =
  | 'completed'
  | 'incomplete'
  | 'cancelled'
  | 'error'
  | 'interrupted';

/** The one mapping from how a run ended to its durable summary (user and sub-agent runs). */
export function lastRunFrom(run: {
  runId: string;
  outcome: RunOutcome;
  iterations: number;
  toolCalls: number;
  limitReason?: string;
  system1?: System1RunReport | null;
}): ThreadLastRun {
  const { outcome } = run;
  const limitReason =
    outcome === 'cancelled'
      ? RUN_CANCELLED_REASON
      : outcome === 'interrupted'
        ? RUN_INTERRUPTED_REASON
        : outcome === 'incomplete'
          ? run.limitReason
          : undefined;
  return {
    runId: run.runId,
    status:
      outcome === 'completed'
        ? 'completed'
        : outcome === 'error' || outcome === 'interrupted'
          ? 'error'
          : 'incomplete',
    incomplete: outcome !== 'completed' && outcome !== 'error',
    iterations: run.iterations,
    toolCalls: run.toolCalls,
    finishedAt: new Date().toISOString(),
    ...(limitReason ? { limitReason } : {}),
    ...(run.system1?.fallbacks.length ? { system1: run.system1 } : {}),
  };
}

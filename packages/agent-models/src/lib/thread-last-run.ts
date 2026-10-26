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
  };
}

/** Tool result content that means the call was skipped by a loop gate. */
export function isLimitSkipToolContent(content: string): boolean {
  return (
    /^limit\.(repeat|tools|read_storm|terminal|unknown|outcome):/i.test(
      content,
    ) || content.startsWith('Skipped: tool call limit')
  );
}

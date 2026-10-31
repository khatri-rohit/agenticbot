import type { RunMetrics } from './run-metrics.js';

export type ThreadMetrics = {
  threadId: string;
  runCount: number;
  totalIterations: number;
  totalToolCalls: number;
  totalPromptTokens: number;
  totalChildPromptTokens: number;
  medianIdleShare: number;
  medianIterations: number;
  limitRate: number;
  runs: RunMetrics[];
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Aggregate RunMetrics for a thread. Used by the Explore pane (E4a) to show
 * how real work behaved without opening individual runs.
 */
export function computeThreadMetrics(
  threadId: string,
  runs: RunMetrics[],
): ThreadMetrics {
  const idleShares = runs.map((r) => r.idleShare);
  const iterations = runs.map((r) => r.iterations);
  const limited = runs.filter((r) => r.limits.length > 0).length;

  return {
    threadId,
    runCount: runs.length,
    totalIterations: runs.reduce((a, r) => a + r.iterations, 0),
    totalToolCalls: runs.reduce((a, r) => a + r.toolCalls, 0),
    totalPromptTokens: runs.reduce((a, r) => a + r.promptTokens.total, 0),
    totalChildPromptTokens: runs.reduce((a, r) => a + r.childPromptTokens, 0),
    medianIdleShare: median(idleShares),
    medianIterations: median(iterations),
    limitRate: runs.length > 0 ? limited / runs.length : 0,
    runs,
  };
}
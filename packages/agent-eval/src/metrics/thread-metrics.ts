import type { UsageRecord } from '../read/usage.js';
import type { RunMetrics } from './run-metrics.js';

export type MetricsSummary = {
  runs: number;
  byStatus: Record<string, number>;
  limits: Record<string, number>;
  promptTokens: number;
  completionTokens: number;
  edits: number;
  /** Median over runs that have the metric. */
  medianPromptPerRun: number | null;
  medianIdleShare: number | null;
  readWalks: number;
  stallNudges: number;
  researchGates: number;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Aggregate a set of runs (a thread, or everything since a date). */
export function summarizeMetrics(list: RunMetrics[]): MetricsSummary {
  const byStatus: Record<string, number> = {};
  const limits: Record<string, number> = {};
  for (const metrics of list) {
    byStatus[metrics.status] = (byStatus[metrics.status] ?? 0) + 1;
    const code = metrics.limitReason?.split(':')[0];
    if (code) limits[code] = (limits[code] ?? 0) + 1;
  }
  return {
    runs: list.length,
    byStatus,
    limits,
    promptTokens: list.reduce((sum, m) => sum + m.promptTokens.total, 0),
    completionTokens: list.reduce((sum, m) => sum + m.completionTokens.total, 0),
    edits: list.reduce((sum, m) => sum + m.edits, 0),
    medianPromptPerRun: median(list.map((m) => m.promptTokens.total)),
    medianIdleShare: median(
      list.map((m) => m.idleShare).filter((value): value is number => value !== null),
    ),
    readWalks: list.reduce((sum, m) => sum + m.readWalks.length, 0),
    stallNudges: list.reduce((sum, m) => sum + m.steering.stallNudges, 0),
    researchGates: list.reduce((sum, m) => sum + m.steering.researchGates, 0),
  };
}

export type CapacityRate = {
  model: string;
  runs: number;
  promptTokens: number;
  weeklyPercent: number;
  /** % of the weekly allowance per 1M prompt tokens (own + sub-agents). */
  weeklyPercentPer1M: number;
};

/**
 * "% of the week per 1M prompt tokens", per model, from the usage log.
 * Balance percentages are whole numbers and shared with other clients, so
 * one run says little; the rate is only meaningful over many rows. Rows
 * whose weekly balance went up (a reset happened mid-run) are skipped.
 */
export function capacityRates(records: UsageRecord[]): CapacityRate[] {
  const byModel = new Map<string, { runs: number; prompt: number; weekly: number }>();
  for (const record of records) {
    const before = record.balanceBefore;
    const after = record.balanceAfter;
    if (!before || !after || !('weeklyRemainingPercent' in before) || !('weeklyRemainingPercent' in after)) {
      continue;
    }
    const delta = before.weeklyRemainingPercent - after.weeklyRemainingPercent;
    const prompt =
      (record.usage?.own.promptTokens ?? 0) + (record.usage?.children.promptTokens ?? 0);
    if (delta < 0 || prompt <= 0) continue;
    const entry = byModel.get(record.model) ?? { runs: 0, prompt: 0, weekly: 0 };
    entry.runs += 1;
    entry.prompt += prompt;
    entry.weekly += delta;
    byModel.set(record.model, entry);
  }
  return [...byModel.entries()].map(([model, entry]) => ({
    model,
    runs: entry.runs,
    promptTokens: entry.prompt,
    weeklyPercent: entry.weekly,
    weeklyPercentPer1M: (entry.weekly / entry.prompt) * 1_000_000,
  }));
}

import { stopLabel } from '../read/runs.js';
import type { UsageRecord } from '../read/usage.js';
import type { RunMetrics } from './run-metrics.js';

export type MetricsSummary = {
  runs: number;
  byStatus: Record<string, number>;
  /** Stop reasons by `stopLabel`. */
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
  memoryGate: Record<string, number>;
  /** Over runs with System 1 lines; null when none had any. */
  system1: {
    runs: number;
    modes: Record<string, number>;
    decisions: number;
    applied: number;
    changed: number;
    fallbacks: number;
  } | null;
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
  const memoryGate: Record<string, number> = {};
  for (const metrics of list) {
    byStatus[metrics.status] = (byStatus[metrics.status] ?? 0) + 1;
    const label = stopLabel(metrics.limitReason);
    if (label) limits[label] = (limits[label] ?? 0) + 1;
    for (const [verdict, n] of Object.entries(metrics.memoryGate)) {
      memoryGate[verdict] = (memoryGate[verdict] ?? 0) + n;
    }
  }
  const withSystem1 = list.flatMap((m) => (m.system1 ? [m.system1] : []));
  const modes: Record<string, number> = {};
  for (const s1 of withSystem1) modes[s1.mode] = (modes[s1.mode] ?? 0) + 1;
  const sum = (pick: (s1: (typeof withSystem1)[number]) => number) =>
    withSystem1.reduce((total, s1) => total + pick(s1), 0);
  return {
    runs: list.length,
    byStatus,
    limits,
    // Own only: sub-agent runs are in the list too, and a parent's total already holds their spend.
    promptTokens: list.reduce((sum, m) => sum + m.promptTokens.own, 0),
    completionTokens: list.reduce((sum, m) => sum + m.completionTokens.own, 0),
    edits: list.reduce((sum, m) => sum + m.edits, 0),
    medianPromptPerRun: median(list.map((m) => m.promptTokens.total)),
    medianIdleShare: median(
      list.map((m) => m.idleShare).filter((value): value is number => value !== null),
    ),
    readWalks: list.reduce((sum, m) => sum + m.readWalks.length, 0),
    stallNudges: list.reduce((sum, m) => sum + m.steering.stallNudges, 0),
    researchGates: list.reduce((sum, m) => sum + m.steering.researchGates, 0),
    memoryGate,
    system1:
      withSystem1.length === 0
        ? null
        : {
            runs: withSystem1.length,
            modes,
            decisions: sum((s1) => s1.decisions),
            applied: sum((s1) => s1.applied),
            changed: sum((s1) => s1.changed),
            fallbacks: sum((s1) => Object.values(s1.fallbacks).reduce((a, b) => a + b, 0)),
          },
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

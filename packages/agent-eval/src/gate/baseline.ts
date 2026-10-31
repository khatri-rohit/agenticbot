import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { TaskResult } from '../runner/runner.js';

/**
 * Baseline record for one task in a suite. Written only by the gate tool
 * after a passing comparison — never by hand. The gate refuses to compare
 * if harnessSha or model differs from the current run.
 */
export type BaselineRecord = {
  taskId: string;
  successRate: number;
  medianPromptTokens: number;
  medianMinutes: number;
  scopeViolations: number;
  trials: number;
  harnessSha: string;
  model: string;
  recordedAt: string;
};

type BaselineFile = {
  suite: string;
  harnessSha: string;
  model: string;
  recordedAt: string;
  tasks: BaselineRecord[];
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

/**
 * Record a baseline from a suite's task results. Writes to
 * evals/baselines/<suite>.json. Only call after a gate passes.
 */
export async function recordBaseline(
  evalsDir: string,
  suite: string,
  results: TaskResult[],
  harnessSha: string,
  model: string,
): Promise<BaselineFile> {
  // Group by taskId.
  const byTask = new Map<string, TaskResult[]>();
  for (const result of results) {
    const arr = byTask.get(result.taskId) ?? [];
    arr.push(result);
    byTask.set(result.taskId, arr);
  }

  const tasks: BaselineRecord[] = [];
  for (const [taskId, trials] of byTask) {
    const successes = trials.filter((t) => t.status === 'pass').length;
    const tokens = trials
      .map((t) => t.metrics?.promptTokens.total ?? 0)
      .filter((n) => n > 0);
    const minutes = trials
      .map((t) => (t.metrics?.wallMs ?? 0) / 60_000)
      .filter((n) => n > 0);
    const violations = trials.reduce(
      (a, t) => a + t.scopeViolations.length,
      0,
    );

    tasks.push({
      taskId,
      successRate: trials.length > 0 ? successes / trials.length : 0,
      medianPromptTokens: median(tokens),
      medianMinutes: Math.round(median(minutes) * 100) / 100,
      scopeViolations: violations,
      trials: trials.length,
      harnessSha,
      model,
      recordedAt: new Date().toISOString(),
    });
  }

  const baseline: BaselineFile = {
    suite,
    harnessSha,
    model,
    recordedAt: new Date().toISOString(),
    tasks,
  };

  const file = path.join(evalsDir, 'baselines', `${suite}.json`);
  await writeFile(file, JSON.stringify(baseline, null, 2));
  return baseline;
}

/**
 * Read a baseline file. Returns null if it doesn't exist.
 */
export async function readBaseline(
  evalsDir: string,
  suite: string,
): Promise<BaselineFile | null> {
  const file = path.join(evalsDir, 'baselines', `${suite}.json`);
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as BaselineFile;
  } catch {
    return null;
  }
}
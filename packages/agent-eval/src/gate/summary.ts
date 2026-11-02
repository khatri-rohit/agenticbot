import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { TrialResult } from '../runner/runner.js';

/** Spread (max ÷ min prompt tokens) above this marks a task unstable: no token verdict. */
export const UNSTABLE_SPREAD = 2;

export type TaskStats = {
  taskId: string;
  taskHash: string;
  /** Trials that ran (skipped trials excluded). */
  trials: number;
  passes: number;
  errors: number;
  passRate: number;
  /** Median prompt tokens over passing trials. */
  medianPromptTokens: number | null;
  medianMinutes: number | null;
  /** max ÷ min prompt tokens over trials that reported tokens. */
  spread: number | null;
  /** At least two trials and spread ≤ UNSTABLE_SPREAD. */
  stable: boolean;
  scopeViolations: number;
};

export type SuiteStats = {
  model: string;
  seedHash: string;
  harnessSha: string;
  harnessDirty: string | null;
  tasks: Record<string, TaskStats>;
  /** Passing trials ÷ trials that ran, over the whole suite. */
  passRate: number;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Trial results of one suite run (`<results>/<task>-<n>.json`; summary.json excluded). */
export async function readResults(dir: string): Promise<TrialResult[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json') && file !== 'summary.json');
  const results: TrialResult[] = [];
  for (const file of files.sort()) {
    results.push(JSON.parse(await readFile(path.join(dir, file), 'utf8')) as TrialResult);
  }
  return results;
}

/** Per-task stats of one suite run. Throws if trials disagree on model, seed or harness. */
export function summarizeSuite(results: TrialResult[]): SuiteStats {
  const ran = results.filter((result) => result.status !== 'skipped');
  if (ran.length === 0) throw new Error('No trials ran in these results (all skipped).');
  const first = ran[0]!;
  for (const result of ran) {
    for (const key of ['model', 'seedHash', 'harnessSha', 'harnessDirty'] as const) {
      if (result[key] !== first[key]) throw new Error(`Results mix ${key} values (${first[key]} vs ${result[key]}).`);
    }
  }
  const byTask = new Map<string, TrialResult[]>();
  for (const result of ran) byTask.set(result.taskId, [...(byTask.get(result.taskId) ?? []), result]);

  const tasks: Record<string, TaskStats> = {};
  for (const [taskId, trials] of byTask) {
    const hashes = new Set(trials.map((trial) => trial.taskHash));
    if (hashes.size > 1) throw new Error(`Task ${taskId} changed during the run (several task hashes).`);
    const passing = trials.filter((trial) => trial.status === 'passed');
    const tokens = trials
      .map((trial) => trial.promptTokens)
      .filter((value): value is number => typeof value === 'number' && value > 0);
    const spread = tokens.length > 0 ? Math.max(...tokens) / Math.min(...tokens) : null;
    tasks[taskId] = {
      taskId,
      taskHash: trials[0]!.taskHash,
      trials: trials.length,
      passes: passing.length,
      errors: trials.filter((trial) => trial.status === 'error').length,
      passRate: passing.length / trials.length,
      medianPromptTokens: median(
        passing.map((trial) => trial.promptTokens).filter((value): value is number => typeof value === 'number'),
      ),
      medianMinutes: median(
        passing.map((trial) => trial.minutes).filter((value): value is number => typeof value === 'number'),
      ),
      spread,
      stable: trials.length >= 2 && spread !== null && spread <= UNSTABLE_SPREAD,
      scopeViolations: trials.reduce((sum, trial) => sum + (trial.scopeViolations?.length ?? 0), 0),
    };
  }
  return {
    model: first.model,
    seedHash: first.seedHash,
    harnessSha: first.harnessSha,
    harnessDirty: first.harnessDirty,
    tasks,
    passRate: ran.filter((result) => result.status === 'passed').length / ran.length,
  };
}

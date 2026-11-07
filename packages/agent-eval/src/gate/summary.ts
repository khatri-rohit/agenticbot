import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { SUITE_META_FILE, type SuiteRunMeta, type TrialResult } from '../runner/runner.js';
import type { TaskSuite } from '../runner/task.js';

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
  /** Absent on baselines recorded before it was tracked. */
  suite?: TaskSuite;
  model: string;
  seedHash: string;
  harnessSha: string;
  harnessDirty: string | null;
  /** `TrialResult.system1Setup` shared by every trial; `unrecorded` for results written before it existed. */
  system1Setup: string;
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

/** Trial results of one suite run (`<results>/<task>-<n>.json`; the meta file excluded). */
export async function readResults(dir: string): Promise<TrialResult[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith('.json') && file !== SUITE_META_FILE);
  const results: TrialResult[] = [];
  for (const file of files.sort()) {
    results.push(JSON.parse(await readFile(path.join(dir, file), 'utf8')) as TrialResult);
  }
  return results;
}

/**
 * A suite run's meta and trials. `meta` is null for folders written before
 * the meta file existed (or an unreadable one); the trials are still read.
 */
export async function readSuiteRun(dir: string): Promise<{ id: string; meta: SuiteRunMeta | null; results: TrialResult[] }> {
  let meta: SuiteRunMeta | null = null;
  try {
    const raw = JSON.parse(await readFile(path.join(dir, SUITE_META_FILE), 'utf8')) as Partial<SuiteRunMeta>;
    // Older summary.json files have no `tasks`; they are not a meta file.
    if (typeof raw.label === 'string' && Array.isArray(raw.tasks)) meta = raw as SuiteRunMeta;
  } catch {
    meta = null;
  }
  return { id: path.basename(dir), meta, results: await readResults(dir) };
}

/** Suite runs under `<evalHome>/results`, newest first (folder names start with an ISO stamp). */
export async function listSuiteRuns(resultsRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(resultsRoot, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
  } catch {
    return [];
  }
}

/** Per-task stats of one suite run. Throws if trials disagree on suite, model, seed or harness. */
export function summarizeSuite(results: TrialResult[]): SuiteStats {
  const ran = results.filter((result) => result.status !== 'skipped');
  if (ran.length === 0) throw new Error('No trials ran in these results (all skipped).');
  const first = ran[0]!;
  for (const result of ran) {
    for (const key of ['suite', 'model', 'seedHash', 'harnessSha', 'harnessDirty'] as const) {
      if (result[key] !== first[key]) throw new Error(`Results mix ${key} values (${first[key]} vs ${result[key]}).`);
    }
  }
  // Trials that errored before any run have no setup; the others must agree.
  const setups = new Set(ran.flatMap((result) => (result.system1Setup ? [result.system1Setup] : [])));
  if (setups.size > 1) throw new Error(`Results mix System 1 setups (${[...setups].join(', ')}).`);
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
    suite: first.suite,
    model: first.model,
    seedHash: first.seedHash,
    harnessSha: first.harnessSha,
    harnessDirty: first.harnessDirty,
    system1Setup: [...setups][0] ?? 'unrecorded',
    tasks,
    passRate: ran.filter((result) => result.status === 'passed').length / ran.length,
  };
}

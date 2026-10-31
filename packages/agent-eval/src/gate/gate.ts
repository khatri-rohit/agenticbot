import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { TaskResult } from '../runner/runner.js';
import { readBaseline, type BaselineRecord } from './baseline.js';

export type GateTaskDelta = {
  taskId: string;
  baseline: BaselineRecord;
  current: {
    successRate: number;
    medianPromptTokens: number;
    medianMinutes: number;
    scopeViolations: number;
    trials: number;
  };
  successDrop: number;
  tokenIncreasePct: number;
  scopeViolationIncrease: number;
  spread: number;
  passed: boolean;
  reasons: string[];
};

export type GateResult = {
  suite: string;
  passed: boolean;
  harnessSha: string;
  model: string;
  baselineHarnessSha: string;
  baselineModel: string;
  shaMismatch: boolean;
  modelMismatch: boolean;
  deltas: GateTaskDelta[];
};

const TOKEN_THRESHOLD_PCT = 0.10;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

/**
 * Compare current trial results against a recorded baseline. Gate rules
 * (from the impl plan):
 * - Fail if regression success drops at all (successDrop > 0).
 * - Fail if median prompt tokens rise >10% on any task.
 * - Fail if scope violations rise.
 * - Medians only, never single trials.
 * - Spread >2× on a task flags it unstable → cannot gate.
 *
 * The gate refuses to compare if harnessSha or model differs from the
 * baseline — this makes "never move model and harness together" a
 * mechanical check.
 *
 * Structural separation: this function reads only evals/baselines/ and
 * evals/results/. It never imports or reads evals/analyst/. The Analyst
 * is advisory-only by import graph, not by convention.
 */
export async function runGate(
  evalsDir: string,
  suite: string,
  currentResults: TaskResult[],
  harnessSha: string,
  model: string,
): Promise<GateResult> {
  const baseline = await readBaseline(evalsDir, suite);
  if (!baseline) {
    return {
      suite,
      passed: false,
      harnessSha,
      model,
      baselineHarnessSha: 'none',
      baselineModel: 'none',
      shaMismatch: true,
      modelMismatch: false,
      deltas: [],
    };
  }

  const shaMismatch = baseline.harnessSha !== harnessSha;
  const modelMismatch = baseline.model !== model;

  // Group current results by taskId.
  const byTask = new Map<string, TaskResult[]>();
  for (const result of currentResults) {
    const arr = byTask.get(result.taskId) ?? [];
    arr.push(result);
    byTask.set(result.taskId, arr);
  }

  const deltas: GateTaskDelta[] = [];
  let allPassed = true;

  for (const baseTask of baseline.tasks) {
    const trials = byTask.get(baseTask.taskId) ?? [];
    const successes = trials.filter((t) => t.status === 'pass').length;
    const tokens = trials
      .map((t) => t.metrics?.promptTokens.total ?? 0)
      .filter((n) => n > 0);
    const minutes = trials
      .map((t) => (t.metrics?.wallMs ?? 0) / 60_000)
      .filter((n) => n > 0);
    const violations = trials.reduce((a, t) => a + t.scopeViolations.length, 0);

    const currentSuccessRate = trials.length > 0 ? successes / trials.length : 0;
    const currentMedianTokens = median(tokens);
    const currentMedianMinutes = Math.round(median(minutes) * 100) / 100;
    const currentViolations = violations;

    const successDrop = baseTask.successRate - currentSuccessRate;
    const tokenIncreasePct = baseTask.medianPromptTokens > 0
      ? (currentMedianTokens - baseTask.medianPromptTokens) / baseTask.medianPromptTokens
      : 0;
    const scopeViolationIncrease = currentViolations - baseTask.scopeViolations;

    // Spread: max/min of token per-call across trials. >2× = unstable.
    const tokenValues = trials
      .map((t) => t.metrics?.promptTokens.total ?? 0)
      .filter((n) => n > 0);
    const spread = tokenValues.length > 1 && Math.min(...tokenValues) > 0
      ? Math.max(...tokenValues) / Math.min(...tokenValues)
      : 1;

    const reasons: string[] = [];
    if (successDrop > 0) reasons.push(`success dropped ${successDrop.toFixed(2)}`);
    if (tokenIncreasePct > TOKEN_THRESHOLD_PCT) reasons.push(`tokens +${(tokenIncreasePct * 100).toFixed(0)}%`);
    if (scopeViolationIncrease > 0) reasons.push(`scope violations +${scopeViolationIncrease}`);
    if (spread > 2) reasons.push(`unstable: spread ${spread.toFixed(1)}×`);

    const passed = reasons.length === 0;
    if (!passed) allPassed = false;

    deltas.push({
      taskId: baseTask.taskId,
      baseline: baseTask,
      current: {
        successRate: currentSuccessRate,
        medianPromptTokens: currentMedianTokens,
        medianMinutes: currentMedianMinutes,
        scopeViolations: currentViolations,
        trials: trials.length,
      },
      successDrop,
      tokenIncreasePct,
      scopeViolationIncrease,
      spread,
      passed,
      reasons,
    });
  }

  // SHA/model mismatch blocks the gate entirely.
  if (shaMismatch || modelMismatch) allPassed = false;

  return {
    suite,
    passed: allPassed,
    harnessSha,
    model,
    baselineHarnessSha: baseline.harnessSha,
    baselineModel: baseline.model,
    shaMismatch,
    modelMismatch,
    deltas,
  };
}
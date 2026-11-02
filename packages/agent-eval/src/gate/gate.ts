import type { SuiteStats, TaskStats } from './summary.js';

/** A task fails when it loses this many passing trials (scaled to its trial count). */
export const MAX_LOST_TRIALS = 2;
/** The suite fails when its pass rate drops by more than this many points. */
export const MAX_SUITE_DROP_POINTS = 10;
/** Median prompt tokens may rise this much on a stable task that passed in both. */
export const MAX_TOKEN_RISE = 0.1;

export type Baseline = SuiteStats & {
  suite: string;
  recordedAt: string;
  /** Set when written with --accept: why an expected regression was accepted. */
  acceptReason?: string;
};

export type TaskVerdict = {
  taskId: string;
  baseline?: TaskStats;
  candidate?: TaskStats;
  failures: string[];
  notes: string[];
};

export type GateResult =
  | { kind: 'refuse'; reasons: string[] }
  | { kind: 'verdict'; passed: boolean; suiteFailures: string[]; tasks: TaskVerdict[] };

/**
 * Compare a candidate suite run with the baseline (plan §8). Refuses (no
 * verdict) when the two were measured on a different model, seed or task
 * definitions; a different harness version is what the gate tests.
 */
export function compareToBaseline(baseline: Baseline, candidate: SuiteStats): GateResult {
  const refuse: string[] = [];
  if (baseline.model !== candidate.model) refuse.push(`model differs: baseline ${baseline.model}, candidate ${candidate.model}`);
  if (baseline.seedHash !== candidate.seedHash) refuse.push('seedHash differs: the eval home was re-seeded with different skills, agents or memory');
  for (const [taskId, base] of Object.entries(baseline.tasks)) {
    const cand = candidate.tasks[taskId];
    if (!cand) refuse.push(`task ${taskId} is in the baseline but did not run`);
    else if (cand.taskHash !== base.taskHash) refuse.push(`task ${taskId} changed since the baseline (taskHash)`);
  }
  if (refuse.length > 0) return { kind: 'refuse', reasons: refuse };

  const tasks: TaskVerdict[] = [];
  for (const [taskId, cand] of Object.entries(candidate.tasks)) {
    const base = baseline.tasks[taskId];
    const verdict: TaskVerdict = { taskId, candidate: cand, failures: [], notes: [] };
    if (!base) {
      verdict.notes.push('new task: not in the baseline, no verdict');
      tasks.push(verdict);
      continue;
    }
    verdict.baseline = base;
    const trials = Math.max(base.trials, cand.trials);
    const lost = (base.passRate - cand.passRate) * trials;
    if (lost >= MAX_LOST_TRIALS - 1e-9) {
      verdict.failures.push(`lost ${Math.round(lost)} passing trial(s) of ${trials} (${base.passes}/${base.trials} → ${cand.passes}/${cand.trials})`);
    } else if (lost > 1e-9) {
      verdict.notes.push(`one trial flipped (${base.passes}/${base.trials} → ${cand.passes}/${cand.trials}): within noise`);
    }
    if (cand.scopeViolations > base.scopeViolations) {
      verdict.failures.push(`scope violations rose ${base.scopeViolations} → ${cand.scopeViolations}`);
    }
    if (base.medianPromptTokens !== null && cand.medianPromptTokens !== null) {
      if (base.stable && cand.stable) {
        const rise = cand.medianPromptTokens / base.medianPromptTokens - 1;
        if (rise > MAX_TOKEN_RISE) {
          verdict.failures.push(`median prompt tokens rose ${Math.round(rise * 100)}% (${base.medianPromptTokens} → ${cand.medianPromptTokens})`);
        }
      } else {
        verdict.notes.push('unstable or too few trials: no token verdict');
      }
    }
    if (cand.errors > 0) verdict.notes.push(`${cand.errors} trial(s) errored (infrastructure, counted as not passing)`);
    tasks.push(verdict);
  }

  // The suite rule also needs MAX_LOST_TRIALS lost trials overall: in a small
  // suite one flipped trial is already >10 points, which is noise, not signal.
  const suiteFailures: string[] = [];
  const drop = (baseline.passRate - candidate.passRate) * 100;
  const candidateTrials = Object.values(candidate.tasks).reduce((sum, task) => sum + task.trials, 0);
  const lostOverall = ((baseline.passRate - candidate.passRate) * candidateTrials);
  if (drop > MAX_SUITE_DROP_POINTS && lostOverall >= MAX_LOST_TRIALS - 1e-9) {
    suiteFailures.push(
      `suite pass rate dropped ${Math.round(drop)} points (${Math.round(baseline.passRate * 100)}% → ${Math.round(candidate.passRate * 100)}%, ${Math.round(lostOverall)} trials)`,
    );
  }
  const passed = suiteFailures.length === 0 && tasks.every((task) => task.failures.length === 0);
  return { kind: 'verdict', passed, suiteFailures, tasks };
}

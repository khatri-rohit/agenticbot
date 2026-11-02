import path from 'node:path';

import { readBaseline, recordBaseline } from '../gate/baseline.js';
import { compareToBaseline, type GateResult } from '../gate/gate.js';
import { readResults, summarizeSuite, type SuiteStats } from '../gate/summary.js';
import { flag, type Args } from './args.js';
import { table, tokens } from './format.js';
import { runCommandFor, suiteFlag } from './trials.js';

const RUN_OPTIONS = `[--results <dir> | run options: --repeat 3 --model … --api … --label …]`;

export const BASELINE_HELP = `baseline --suite regression ${RUN_OPTIONS} [--accept "<reason>"] [--baselines evals/baselines]
  Record the suite's baseline. Refuses to replace one unless the candidate passes the gate or --accept is given.`;

export const GATE_HELP = `gate --suite regression ${RUN_OPTIONS} [--baselines evals/baselines]
  Compare a suite run with the baseline. Exit 0 pass, 1 fail, 2 refused (model, seed or tasks differ).`;

/** Stats from an existing results folder, or from a fresh suite run (spends capacity). */
async function candidate(args: Args, suite: string): Promise<SuiteStats> {
  const results = flag(args, 'results');
  if (results) return summarizeSuite(await readResults(path.resolve(results)));
  const run = await runCommandFor(args, { suite: suite as 'regression' | 'capability' });
  return summarizeSuite(run.results);
}

function printVerdict(result: GateResult): void {
  if (result.kind === 'refuse') {
    console.log(`REFUSED (no verdict):\n- ${result.reasons.join('\n- ')}`);
    return;
  }
  console.log(
    table(
      ['task', 'passes base → cand', 'median tokens base → cand', 'stable', 'scope', 'verdict'],
      result.tasks.map((task) => [
        task.taskId,
        task.baseline ? `${task.baseline.passes}/${task.baseline.trials} → ${task.candidate!.passes}/${task.candidate!.trials}` : `new: ${task.candidate!.passes}/${task.candidate!.trials}`,
        `${tokens(task.baseline?.medianPromptTokens ?? undefined)} → ${tokens(task.candidate?.medianPromptTokens ?? undefined)}`,
        `${task.baseline?.stable ? 'y' : 'n'}/${task.candidate?.stable ? 'y' : 'n'}`,
        `${task.baseline?.scopeViolations ?? '-'} → ${task.candidate?.scopeViolations ?? '-'}`,
        task.failures.length ? `FAIL: ${task.failures.join('; ')}` : task.notes.join('; ') || 'ok',
      ]),
    ),
  );
  for (const failure of result.suiteFailures) console.log(`SUITE FAIL: ${failure}`);
  console.log(result.passed ? '\nGATE PASSED' : '\nGATE FAILED');
}

export async function baselineCommand(args: Args): Promise<number> {
  const suite = suiteFlag(args);
  if (!suite) {
    console.error(BASELINE_HELP);
    return 1;
  }
  const stats = await candidate(args, suite);
  const accept = flag(args, 'accept');
  const outcome = await recordBaseline({
    baselinesDir: path.resolve(flag(args, 'baselines') ?? 'evals/baselines'),
    suite,
    stats,
    ...(accept ? { acceptReason: accept } : {}),
  });
  if (!outcome.written) {
    console.error(`Baseline not written: ${outcome.why}`);
    return 1;
  }
  console.log(`Baseline written: ${outcome.path}`);
  return 0;
}

export async function gateCommand(args: Args): Promise<number> {
  const suite = suiteFlag(args);
  if (!suite) {
    console.error(GATE_HELP);
    return 1;
  }
  const baselinesDir = path.resolve(flag(args, 'baselines') ?? 'evals/baselines');
  let baseline;
  try {
    baseline = await readBaseline(baselinesDir, suite);
  } catch (error) {
    console.log(`REFUSED (no verdict):\n- ${error instanceof Error ? error.message : error}`);
    return 2;
  }
  if (!baseline) {
    console.log(`REFUSED (no verdict):\n- no baseline for suite "${suite}" in ${baselinesDir}. Record one with: baseline --suite ${suite}`);
    return 2;
  }
  const result = compareToBaseline(baseline, await candidate(args, suite));
  printVerdict(result);
  if (result.kind === 'refuse') return 2;
  return result.passed ? 0 : 1;
}

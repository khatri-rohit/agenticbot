import path from 'node:path';

import { WORKSPACE_MODE } from '@agent/agent-models';

import { capacityRates } from '../metrics/thread-metrics.js';
import { readUsage } from '../read/usage.js';
import { runSuite, type SuiteRun } from '../runner/runner.js';
import { seedEvalHome } from '../runner/seed.js';
import { loadTasks, type TaskSuite } from '../runner/task.js';
import { agentHome, evalHome, flag, intFlag, type Args } from './args.js';

export const SEED_HELP = `seed [--home <personal home>] [--eval-home <dir>]
  Copy skills, agents and user memory into the eval home; write seed.json with its hash.`;

export const RUN_HELP = `run (--task <id> | --suite regression|capability) [--repeat 1] [--model <id>]
    [--api http://localhost:3333/api/agent] [--continues 2] [--max-weekly-percent 10]
    [--label <name>] [--tasks-dir evals/tasks] [--eval-home <dir>]
  Run trials through a running API whose AGENT_HOME is the eval home; grade each from its end state.`;

export async function seedCommand(args: Args): Promise<number> {
  const info = await seedEvalHome(agentHome(args), evalHome(args));
  console.log(`Seeded ${evalHome(args)} from ${info.from}: ${info.files} files, seedHash ${info.seedHash.slice(0, 12)}`);
  return 0;
}

export function suiteFlag(args: Args): TaskSuite | undefined {
  const suite = flag(args, 'suite');
  if (suite === undefined) return undefined;
  if (suite !== 'regression' && suite !== 'capability') throw new Error('--suite must be regression or capability');
  return suite;
}

/** Load the selected tasks, print the cost estimate, run the suite. */
export async function runCommandFor(
  args: Args,
  select: { suite?: TaskSuite; id?: string },
): Promise<SuiteRun> {
  const tasks = await loadTasks(path.resolve(flag(args, 'tasks-dir') ?? 'evals/tasks'), select);
  const repeat = intFlag(args, 'repeat', 1);
  const model = flag(args, 'model') ?? WORKSPACE_MODE.model;

  // Cost estimate from the personal usage log, before spending anything.
  const rate = capacityRates((await readUsage(agentHome(args))).records).find((r) => r.model === model);
  const budget = tasks.reduce((sum, loaded) => sum + loaded.task.budget.maxPromptTokens, 0) * repeat;
  console.log(
    `${tasks.length} task(s) × ${repeat} trial(s) on ${model}; worst case ${(budget / 1_000_000).toFixed(1)}M prompt tokens` +
      (rate ? ` ≈ ${((budget / 1_000_000) * rate.weeklyPercentPer1M).toFixed(1)}% of the week` : ' (no capacity rate for this model yet)'),
  );

  const run = await runSuite({
    tasks,
    repeat,
    harnessRoot: process.cwd(),
    evalHome: evalHome(args),
    apiBase: flag(args, 'api') ?? 'http://localhost:3333/api/agent',
    model,
    continues: intFlag(args, 'continues', 2),
    maxWeeklyPercent: intFlag(args, 'max-weekly-percent', 10),
    label: flag(args, 'label') ?? (select.id ?? select.suite ?? 'run'),
    log: (message) => console.log(message),
  });
  const counts = run.results.reduce<Record<string, number>>((acc, result) => {
    acc[result.status] = (acc[result.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\nResults in ${run.resultsDir}: ${Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ')}`);
  return run;
}

export async function runCommand(args: Args): Promise<number> {
  const id = flag(args, 'task');
  const suite = suiteFlag(args);
  if (!id && !suite) {
    console.error(RUN_HELP);
    return 1;
  }
  const run = await runCommandFor(args, { ...(suite ? { suite } : {}), ...(id ? { id } : {}) });
  return run.results.some((result) => result.status === 'error') ? 1 : 0;
}

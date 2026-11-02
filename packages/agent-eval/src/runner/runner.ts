import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { readCatalog } from '../read/catalog.js';
import { listRuns } from '../read/runs.js';
import { flattenRuns, loadRunMetrics } from '../metrics/load.js';
import type { RunMetrics } from '../metrics/run-metrics.js';
import { ApiClient } from './api-client.js';
import { checkout, pruneWorkdirs, type Checkout } from './checkout.js';
import { git } from './exec.js';
import { gradeTrial, type Grade } from './score.js';
import { readSeed } from './seed.js';
import type { LoadedTask, TaskSuite } from './task.js';

/** Same set the UI offers Continue for (message-list.tsx isResumableLimit). */
const RESUMABLE = /^limit\.(tokens|wall|iterations|tools|capacity|research):/;
const CONTINUE_MESSAGE = 'Continue from where the last run stopped.';

export type TrialStatus = 'passed' | 'failed' | 'skipped' | 'error';

export type TrialResult = {
  taskId: string;
  suite: TaskSuite;
  trial: number;
  /** The harness under test: commit plus a hash of uncommitted changes. */
  harnessSha: string;
  harnessDirty: string | null;
  seedHash: string;
  taskHash: string;
  model: string;
  status: TrialStatus;
  /** Why it was skipped or errored. */
  reason?: string;
  checksPassed?: boolean;
  filesPassed?: boolean;
  scopeViolations?: string[];
  budgetOk?: boolean;
  continues: number;
  limitReason?: string;
  promptTokens?: number;
  minutes?: number;
  grade?: Grade;
  deps?: Checkout['deps'];
  depsMs?: number;
  metrics?: RunMetrics[];
  threadId?: string;
  runIds: string[];
  startedAt: string;
  finishedAt: string;
};

export type RunnerOptions = {
  tasks: LoadedTask[];
  repeat: number;
  /** Repo whose harness is under test (its HEAD + diff are recorded). */
  harnessRoot: string;
  evalHome: string;
  apiBase: string;
  model: string;
  /** Continue messages allowed per trial on resumable limits. */
  continues: number;
  /** Stop the suite once this many weekly-% points were used since it started. */
  maxWeeklyPercent: number;
  label: string;
  log: (message: string) => void;
};

export type SuiteRun = { resultsDir: string; results: TrialResult[] };

type Balance = { session: number | null; weekly: number | null };

function balanceOf(raw: unknown): Balance {
  const legacy = (raw as { legacy?: { session?: { remainingPercent?: number }; weekly?: { remainingPercent?: number } } } | null)
    ?.legacy;
  return {
    session: legacy?.session?.remainingPercent ?? null,
    weekly: legacy?.weekly?.remainingPercent ?? null,
  };
}

async function harnessVersion(root: string): Promise<{ sha: string; dirty: string | null }> {
  const head = await git(root, ['rev-parse', 'HEAD']);
  const diff = await git(root, ['diff', 'HEAD']);
  return {
    sha: head.stdout.trim(),
    dirty: diff.stdout.trim() ? createHash('sha256').update(diff.stdout).digest('hex').slice(0, 16) : null,
  };
}

/** The API must be serving the eval home; a thread it creates must appear in that catalog. */
async function assertApiOnEvalHome(
  api: ApiClient,
  apiBase: string,
  evalHome: string,
  workspaceRoot: string,
  model: string,
): Promise<void> {
  let probe: { id: string };
  try {
    probe = await api.createThread({ workspaceRoot, model, title: 'agent-eval home probe' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The API is not reachable at ${apiBase} (${message}). Start it with AGENT_HOME=${evalHome}; the runner never starts it.`,
    );
  }
  let seen = false;
  try {
    // No catalog.db yet means this API has never written to the eval home.
    seen = existsSync(path.join(evalHome, 'catalog.db')) &&
      readCatalog(evalHome).some((thread) => thread.id === probe.id);
  } finally {
    await api.deleteThread(probe.id).catch(() => undefined);
  }
  if (!seen) {
    throw new Error(
      `The API is not using the eval home (${evalHome}). Start it with AGENT_HOME set to that folder; the runner never starts or reconfigures it.`,
    );
  }
}

async function runTrial(
  api: ApiClient,
  opts: RunnerOptions,
  loaded: LoadedTask,
  trial: number,
  base: Omit<TrialResult, 'taskId' | 'suite' | 'trial' | 'taskHash' | 'status' | 'continues' | 'runIds' | 'startedAt' | 'finishedAt'>,
): Promise<TrialResult> {
  const { task } = loaded;
  const startedAt = new Date();
  const result: TrialResult = {
    ...base,
    taskId: task.id,
    suite: task.suite,
    trial,
    taskHash: loaded.taskHash,
    status: 'error',
    continues: 0,
    runIds: [],
    startedAt: startedAt.toISOString(),
    finishedAt: '',
  };
  try {
    const workdirs = path.join(opts.evalHome, 'workdirs');
    const tree = await checkout({
      source: path.resolve(opts.harnessRoot, task.repo.source),
      commit: task.repo.commit,
      dir: path.join(workdirs, `${task.id}-${trial}`),
    });
    result.deps = tree.deps;
    result.depsMs = tree.depsMs;

    const thread = await api.createThread({
      workspaceRoot: tree.dir,
      model: opts.model,
      title: `eval ${task.id} #${trial}`,
    });
    result.threadId = thread.id;

    // A hard stop well past the task's own budget, so a stuck run cannot hold the suite.
    const deadline = startedAt.getTime() + task.budget.maxMinutes * 2 * 60_000 + 10 * 60_000;
    let message = task.prompt;
    let limitReason: string | undefined;
    for (;;) {
      const { runId } = await api.startRun({ threadId: thread.id, content: message, model: opts.model, posture: task.posture });
      result.runIds.push(runId);
      const outcome = await api.waitForRun(runId, Math.max(60_000, deadline - Date.now()));
      if (outcome === 'timeout') {
        await api.cancelRun(runId).catch(() => undefined);
        limitReason = 'eval.timeout: trial passed its hard deadline';
        break;
      }
      limitReason = (await api.ledger(thread.id)).lastRun?.limitReason;
      if (!limitReason || !RESUMABLE.test(limitReason) || result.continues >= opts.continues) break;
      result.continues += 1;
      message = CONTINUE_MESSAGE;
    }
    if (limitReason) result.limitReason = limitReason;

    const runs = flattenRuns(await listRuns(opts.evalHome, { threadId: thread.id })).filter((run) =>
      result.runIds.includes(run.runId),
    );
    const metrics = await loadRunMetrics(opts.evalHome, runs);
    result.metrics = metrics;
    const promptTokens = metrics.reduce((sum, m) => sum + m.promptTokens.total, 0);
    const minutes = (Date.now() - startedAt.getTime()) / 60_000;
    result.promptTokens = promptTokens;
    result.minutes = Math.round(minutes * 10) / 10;

    const grade = await gradeTrial({
      task,
      dir: tree.dir,
      promptTokens,
      minutes,
      ...(limitReason ? { unresolvedLimit: limitReason } : {}),
    });
    result.grade = grade;
    result.checksPassed = grade.checksPassed;
    result.filesPassed = grade.filesPassed;
    result.scopeViolations = grade.scopeViolations;
    result.budgetOk = grade.budget.ok;
    result.status = grade.passed ? 'passed' : 'failed';
  } catch (error) {
    result.status = 'error';
    result.reason = error instanceof Error ? error.message : String(error);
  }
  result.finishedAt = new Date().toISOString();
  return result;
}

/**
 * Run each task `repeat` times through the real API on the eval home, grade
 * each trial from its end state, and write one JSON file per trial plus
 * `summary.json` under `<evalHome>/results/<ts>-<label>/`.
 */
export async function runSuite(opts: RunnerOptions): Promise<SuiteRun> {
  const seed = await readSeed(opts.evalHome);
  if (!seed) throw new Error(`The eval home is not seeded. Run: agent-eval seed --eval-home ${opts.evalHome}`);
  if (seed.drifted) throw new Error('The eval home changed since it was seeded. Re-run agent-eval seed.');
  if (opts.tasks.length === 0) throw new Error('No tasks selected.');

  const api = new ApiClient(opts.apiBase);
  const harness = await harnessVersion(opts.harnessRoot);
  const workdirs = path.join(opts.evalHome, 'workdirs');
  await mkdir(workdirs, { recursive: true });
  await assertApiOnEvalHome(api, opts.apiBase, opts.evalHome, workdirs, opts.model);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const resultsDir = path.join(opts.evalHome, 'results', `${stamp}-${opts.label}`);
  await mkdir(resultsDir, { recursive: true });

  const start = balanceOf(await api.balance());
  const results: TrialResult[] = [];
  const base = {
    harnessSha: harness.sha,
    harnessDirty: harness.dirty,
    seedHash: seed.seedHash,
    model: opts.model,
  };
  let stopped: string | undefined;

  for (const loaded of opts.tasks) {
    await pruneWorkdirs(workdirs, loaded.task.id, path.resolve(opts.harnessRoot, loaded.task.repo.source));
    for (let trial = 1; trial <= opts.repeat; trial++) {
      const now = balanceOf(await api.balance());
      if (!stopped && start.weekly !== null && now.weekly !== null && start.weekly - now.weekly >= opts.maxWeeklyPercent) {
        stopped = `suite ceiling: ${start.weekly - now.weekly}% of the week used (max ${opts.maxWeeklyPercent}%)`;
      }
      const capacity =
        (now.session !== null && now.session <= 1) || (now.weekly !== null && now.weekly <= 1)
          ? 'capacity: session or weekly allowance spent'
          : undefined;
      const skip = stopped ?? capacity;
      const result: TrialResult = skip
        ? {
            ...base,
            taskId: loaded.task.id,
            suite: loaded.task.suite,
            trial,
            taskHash: loaded.taskHash,
            status: 'skipped',
            reason: skip,
            continues: 0,
            runIds: [],
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
          }
        : await runTrial(api, opts, loaded, trial, base);
      results.push(result);
      await writeFile(
        path.join(resultsDir, `${loaded.task.id}-${trial}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      opts.log(
        `${loaded.task.id} #${trial}: ${result.status}${result.reason ? ` (${result.reason})` : ''}${result.promptTokens !== undefined ? ` · ${result.promptTokens} prompt tokens · ${result.minutes} min` : ''}`,
      );
    }
  }

  await writeFile(
    path.join(resultsDir, 'summary.json'),
    `${JSON.stringify({ label: opts.label, ...base, startBalance: start, results: results.map(({ grade: _grade, metrics: _metrics, ...rest }) => rest) }, null, 2)}\n`,
  );
  return { resultsDir, results };
}

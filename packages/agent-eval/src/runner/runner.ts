import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isPauseStop, isResumableStop, RUN_CANCELLED_REASON, type ThinkingValue } from '@agent/agent-models';

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

const CONTINUE_MESSAGE = 'Continue from where the last run stopped.';
/** After cancelling a run past its deadline, how long to wait for it to settle before giving up on the trial. */
const CANCEL_SETTLE_MS = 120_000;
/** Reason prefix of trials skipped because the account ran out; the rest of the suite is skipped too. */
const CAPACITY_SKIP = 'capacity';

export type TrialStatus = 'passed' | 'failed' | 'skipped' | 'error';

/**
 * Why a trial's last run ended, so a report can tell "the agent failed" from
 * "the setup failed": settled (normally), timeout (past the trial deadline,
 * cancelled by the runner), cancelled (by someone else), capacity (the
 * account ran out), error (the trial itself failed: API down, checkout,
 * a run that never settled).
 */
export type TrialEnd = 'settled' | 'timeout' | 'cancelled' | 'capacity' | 'error';

/** What a trial needs from the API; `ApiClient` in production, a fake in tests. */
export type TrialClient = Pick<ApiClient, 'createThread' | 'startRun' | 'cancelRun' | 'settledLastRun'>;

export type TrialOptions = Pick<RunnerOptions, 'evalHome' | 'harnessRoot' | 'model' | 'thinking' | 'continues'>;

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
  /** `thinking` sent on every run of the trial; absent = the model default. */
  thinking?: ThinkingValue;
  /**
   * The System 1 setup the trial ran under (`system1SetupOf`). The gate
   * compares only like setups unless asked to compare them (plan D-2).
   */
  system1Setup?: string;
  status: TrialStatus;
  ended?: TrialEnd;
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
  /** `--thinking`; overrides the task's own `thinking`. */
  thinking?: ThinkingValue;
  /** Continue messages allowed per trial on resumable limits. */
  continues: number;
  /** Stop the suite once this many weekly-% points were used since it started. */
  maxWeeklyPercent: number;
  label: string;
  log: (message: string) => void;
};

export type SuiteRun = { resultsDir: string; results: TrialResult[] };

/** `summary.json` in a suite run's results folder; the trial files are the only copy of the results. */
export const SUITE_META_FILE = 'summary.json';

export type SuiteRunMeta = {
  label: string;
  suite: TaskSuite | 'mixed';
  harnessSha: string;
  harnessDirty: string | null;
  seedHash: string;
  model: string;
  thinking?: ThinkingValue;
  tasks: string[];
  repeat: number;
  startBalance: { session: number | null; weekly: number | null };
  startedAt: string;
  finishedAt?: string;
  /** Why the suite stopped early (ceiling, capacity). */
  stopped?: string;
};

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

/**
 * `<mode>/thinking=<value>`, e.g. `enforce/thinking=auto`. The mode is what
 * the traces show (`off` without System 1 lines, `mixed` when runs disagree),
 * not what the API was asked for.
 */
export function system1SetupOf(metrics: RunMetrics[], thinking: ThinkingValue | undefined): string {
  const modes = new Set(metrics.map((m) => m.system1?.mode ?? 'off'));
  const mode = modes.size === 0 ? 'off' : modes.size === 1 ? [...modes][0]! : 'mixed';
  return `${mode}/thinking=${thinking === undefined ? 'default' : String(thinking)}`;
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

/**
 * One trial: a fresh checkout, a thread, the task prompt plus up to
 * `continues` Continue messages on resumable stops, then a grade of the
 * settled workspace. Never throws: failures are an `error` trial.
 */
export async function runTrial(
  api: TrialClient,
  opts: TrialOptions,
  loaded: LoadedTask,
  trial: number,
  base: Omit<TrialResult, 'taskId' | 'suite' | 'trial' | 'taskHash' | 'status' | 'continues' | 'runIds' | 'startedAt' | 'finishedAt'>,
): Promise<TrialResult> {
  const { task } = loaded;
  const startedAt = new Date();
  const thinking = opts.thinking ?? task.thinking;
  const result: TrialResult = {
    ...base,
    taskId: task.id,
    suite: task.suite,
    trial,
    taskHash: loaded.taskHash,
    ...(thinking !== undefined ? { thinking } : {}),
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
      const { runId } = await api.startRun({
        threadId: thread.id,
        content: message,
        model: opts.model,
        posture: task.posture,
        ...(thinking !== undefined ? { thinking } : {}),
      });
      result.runIds.push(runId);
      const lastRun = await api.settledLastRun(thread.id, runId, Math.max(60_000, deadline - Date.now()));
      if (!lastRun) {
        await api.cancelRun(runId);
        // Grade only a settled workspace: a cancelled run can still be finishing a write.
        if (!(await api.settledLastRun(thread.id, runId, CANCEL_SETTLE_MS))) {
          throw new Error(`run ${runId} did not settle within ${CANCEL_SETTLE_MS / 1000}s of its cancel; workspace not graded`);
        }
        result.ended = 'timeout';
        limitReason = 'eval.timeout: trial passed its hard deadline';
        break;
      }
      limitReason = lastRun.limitReason;
      result.ended = limitReason === RUN_CANCELLED_REASON ? 'cancelled' : 'settled';
      // A pause (account ran out) is resumable for a person, not for a trial.
      if (!limitReason || !isResumableStop(limitReason) || isPauseStop(limitReason)) break;
      if (result.continues >= opts.continues) break;
      result.continues += 1;
      message = CONTINUE_MESSAGE;
    }
    if (limitReason) result.limitReason = limitReason;

    const runs = flattenRuns(await listRuns(opts.evalHome, { threadId: thread.id })).filter((run) =>
      result.runIds.includes(run.runId),
    );
    const metrics = await loadRunMetrics(opts.evalHome, runs);
    result.metrics = metrics;
    result.system1Setup = system1SetupOf(metrics, thinking);

    // The account ran out, not the agent: the trial gets no grade (plan D-3).
    if (limitReason && isPauseStop(limitReason)) {
      result.ended = 'capacity';
      result.status = 'skipped';
      result.reason = `${CAPACITY_SKIP}: ${limitReason}`;
      result.finishedAt = new Date().toISOString();
      return result;
    }
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
    result.ended = 'error';
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
  const suites = new Set(opts.tasks.map((loaded) => loaded.task.suite));
  const meta: SuiteRunMeta = {
    label: opts.label,
    suite: suites.size === 1 ? [...suites][0]! : 'mixed',
    ...base,
    ...(opts.thinking !== undefined ? { thinking: opts.thinking } : {}),
    tasks: opts.tasks.map((loaded) => loaded.task.id),
    repeat: opts.repeat,
    startBalance: start,
    startedAt: new Date().toISOString(),
  };
  // Written now and again at the end, so an interrupted suite run still says what it was.
  const writeMeta = () => writeFile(path.join(resultsDir, SUITE_META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
  await writeMeta();
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
          ? `${CAPACITY_SKIP}: session or weekly allowance spent`
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
      // A run paused on capacity: every later trial would pause too.
      if (!stopped && !skip && result.status === 'skipped') stopped = result.reason;
      await writeFile(
        path.join(resultsDir, `${loaded.task.id}-${trial}.json`),
        `${JSON.stringify(result, null, 2)}\n`,
      );
      opts.log(
        `${loaded.task.id} #${trial}: ${result.status}${result.reason ? ` (${result.reason})` : ''}${result.promptTokens !== undefined ? ` · ${result.promptTokens} prompt tokens · ${result.minutes} min` : ''}`,
      );
    }
  }

  meta.finishedAt = new Date().toISOString();
  if (stopped) meta.stopped = stopped;
  await writeMeta();
  return { resultsDir, results };
}

import { execSync } from 'node:child_process';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import type { EvalTask } from './task.js';
import { checkoutTask, runCheck, checkFiles, checkScope } from './checkout.js';
import { createApiClient, type ApiClient } from './api-client.js';
import { listRuns } from '../read/runs.js';
import { computeRunMetrics } from '../metrics/run-metrics.js';
import { readUsage } from '../read/usage.js';
import type { RunMetrics } from '../metrics/run-metrics.js';

/**
 * Result of a single trial. Written to
 * evals/results/<ts>-<label>/<task>-<n>.json
 */
export type TaskResult = {
  taskId: string;
  trial: number;
  harnessSha: string;
  model: string;
  status: 'pass' | 'fail' | 'skipped' | 'error';
  checksPassed: boolean;
  filesPassed: boolean;
  scopeViolations: string[];
  budgetOk: boolean;
  limitReason?: string;
  metrics?: RunMetrics;
  tracePath?: string;
  threadId?: string;
  runId?: string;
  error?: string;
};

/**
 * Result of a full suite run. Written to
 * evals/results/<ts>-<label>/suite.json
 */
export type SuiteResult = {
  label: string;
  suite: string;
  harnessSha: string;
  model: string;
  startedAt: string;
  tasks: TaskResult[];
};

function harnessSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const DEFAULT_MODEL = process.env.EVAL_MODEL ?? 'gpt-oss:120b';

/**
 * Run a task suite: for each task, checkout the pinned commit, create a
 * thread, start a run, wait for it to settle, then score against end-state
 * checks, file assertions, scope, and budget. Records harnessSha + model in
 * every result so Compare can attribute deltas.
 *
 * Prerequisite: a running API with AGENT_HOME=evals/home. The runner refuses
 * to start otherwise.
 */
export async function runSuite(opts: {
  evalsDir: string;
  home: string;
  suite: string;
  tasks: EvalTask[];
  repeat?: number;
  api?: ApiClient;
}): Promise<SuiteResult> {
  const api = opts.api ?? createApiClient();
  const sha = harnessSha();
  const label = `${Date.now()}-${opts.suite}`;
  const resultsDir = path.join(opts.evalsDir, 'results', label);
  await mkdir(resultsDir, { recursive: true });

  // Prune stale workdirs.
  const workdirsDir = path.join(opts.evalsDir, 'workdirs');
  try {
    const entries = await readdir(workdirsDir);
    for (const entry of entries) {
      await rm(path.join(workdirsDir, entry), { recursive: true, force: true });
    }
  } catch {
    // No workdirs yet.
  }

  const taskResults: TaskResult[] = [];
  const repeat = opts.repeat ?? 1;

  for (const task of opts.tasks) {
    for (let trial = 1; trial <= repeat; trial++) {
      // Capacity check before each trial.
      const balance = await api.getBalance();
      if (balance.paused || balance.percent < 10) {
        taskResults.push({
          taskId: task.id,
          trial,
          harnessSha: sha,
          model: DEFAULT_MODEL,
          status: 'skipped',
          checksPassed: false,
          filesPassed: false,
          scopeViolations: [],
          budgetOk: false,
          error: 'capacity: balance below 10% or paused',
        });
        continue;
      }

      const workdir = path.join(workdirsDir, `${task.id}-${trial}`);
      try {
        await checkoutTask(task, workdir);

        const { threadId } = await api.createThread({
          model: DEFAULT_MODEL,
          workspaceRoot: workdir,
        });
        const { runId } = await api.startRun({
          threadId,
          prompt: task.prompt,
          posture: task.posture,
        });
        const settled = await api.waitForRun(threadId, runId);

        // Score: end-state checks (run after the trial, against the workspace).
        let checksPassed = true;
        for (const check of task.checks) {
          const result = await runCheck(workdir, check.run);
          if (result.exitCode !== check.expectExit) {
            checksPassed = false;
            break;
          }
        }

        // File assertions.
        const fileResult = await checkFiles(workdir, task.files);

        // Scope.
        const scopeResult = checkScope(workdir, task.scope.allow);

        // Budget: read metrics from the run's trace.
        const runs = await listRuns(opts.home, { threadId });
        const run = runs.find((r) => r.runId === runId);
        const usageRecords = await readUsage(opts.home);
        const usage = usageRecords.find((u) => u.runId === runId);
        const metrics = run ? computeRunMetrics(run, usage) : undefined;

        const budgetOk = metrics
          ? metrics.promptTokens.total <= task.budget.maxPromptTokens &&
            metrics.wallMs <= task.budget.maxMinutes * 60_000
          : false;

        const result: TaskResult = {
          taskId: task.id,
          trial,
          harnessSha: sha,
          model: DEFAULT_MODEL,
          status: checksPassed && fileResult.passed && scopeResult.passed && budgetOk
            ? 'pass'
            : 'fail',
          checksPassed,
          filesPassed: fileResult.passed,
          scopeViolations: scopeResult.violations,
          budgetOk,
          ...(settled.limitReason ? { limitReason: settled.limitReason } : {}),
          ...(metrics ? { metrics } : {}),
          ...(run ? { tracePath: run.tracePath, threadId, runId } : {}),
        };

        taskResults.push(result);
        await writeFile(
          path.join(resultsDir, `${task.id}-${trial}.json`),
          JSON.stringify(result, null, 2),
        );
      } catch (err) {
        const result: TaskResult = {
          taskId: task.id,
          trial,
          harnessSha: sha,
          model: DEFAULT_MODEL,
          status: 'error',
          checksPassed: false,
          filesPassed: false,
          scopeViolations: [],
          budgetOk: false,
          error: err instanceof Error ? err.message : String(err),
        };
        taskResults.push(result);
      } finally {
        await rm(workdir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  const suiteResult: SuiteResult = {
    label,
    suite: opts.suite,
    harnessSha: sha,
    model: DEFAULT_MODEL,
    startedAt: new Date().toISOString(),
    tasks: taskResults,
  };
  await writeFile(
    path.join(resultsDir, 'suite.json'),
    JSON.stringify(suiteResult, null, 2),
  );
  return suiteResult;
}
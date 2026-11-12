import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ThinkingValue } from '@agent/agent-models';

/**
 * `matrix`: one task per task shape (small edit, multi-file edit, read-only
 * extraction, plain question, delegation-heavy research, a file over the
 * read window, shell commands). Every harness change runs it; see
 * docs/plans/harness-v2-build-plan.md.
 */
export type TaskSuite = 'regression' | 'capability' | 'matrix';

export const TASK_SUITES: readonly TaskSuite[] = ['regression', 'capability', 'matrix'];

/** One eval task (`evals/tasks/<suite>/<id>.json`). Graded on the end state, not the transcript. */
export type EvalTask = {
  id: string;
  suite: TaskSuite;
  repo: { source: string; commit: string };
  prompt: string;
  posture: 'agent' | 'ask' | 'plan';
  /** `home`: a chat thread with no workspace (no checkout, no file grading). Default `workspace`. */
  mode?: 'workspace' | 'home';
  /** Sent as `thinking` on every run; absent = the model default. The CLI's --thinking overrides it. */
  thinking?: ThinkingValue;
  checks: { run: string; expectExit: number; timeoutSec?: number }[];
  files: { path: string; mustMatch: string }[];
  /** Patterns the final answer must contain (research and question tasks grade the answer, not files). */
  answer?: { mustMatch: string }[];
  scope: { allow: string[] };
  budget: { maxPromptTokens: number; maxMinutes: number };
};

export type LoadedTask = { task: EvalTask; file: string; taskHash: string };

function fail(file: string, message: string): never {
  throw new Error(`${file}: ${message}`);
}

function str(file: string, value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(file, `"${name}" must be a non-empty string`);
  return value;
}

function num(file: string, value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(file, `"${name}" must be a number`);
  return value;
}

/** Validate a parsed task; every field the runner and grader read is checked here. */
export function parseTask(file: string, raw: unknown): EvalTask {
  if (!raw || typeof raw !== 'object') fail(file, 'not a JSON object');
  const t = raw as Record<string, unknown>;
  const suite = t.suite;
  if (!TASK_SUITES.includes(suite as TaskSuite)) fail(file, `"suite" must be one of ${TASK_SUITES.join(', ')}`);
  const repo = (t.repo ?? {}) as Record<string, unknown>;
  const scope = (t.scope ?? {}) as Record<string, unknown>;
  const budget = (t.budget ?? {}) as Record<string, unknown>;
  if (!Array.isArray(t.checks)) fail(file, '"checks" must be an array');
  if (!Array.isArray(t.files)) fail(file, '"files" must be an array');
  if (!Array.isArray(scope.allow)) fail(file, '"scope.allow" must be an array');
  const posture = t.posture ?? 'agent';
  if (posture !== 'agent' && posture !== 'ask' && posture !== 'plan') fail(file, '"posture" must be agent, ask or plan');
  const mode = t.mode ?? 'workspace';
  if (mode !== 'workspace' && mode !== 'home') fail(file, '"mode" must be workspace or home');
  if (t.answer !== undefined && !Array.isArray(t.answer)) fail(file, '"answer" must be an array');
  const thinking = t.thinking;
  if (thinking !== undefined && typeof thinking !== 'boolean' && typeof thinking !== 'string') {
    fail(file, '"thinking" must be a boolean or a string');
  }
  return {
    id: str(file, t.id, 'id'),
    suite: suite as TaskSuite,
    ...(mode === 'home' ? { mode } : {}),
    repo: { source: str(file, repo.source, 'repo.source'), commit: str(file, repo.commit, 'repo.commit') },
    prompt: str(file, t.prompt, 'prompt'),
    posture,
    ...(thinking !== undefined ? { thinking } : {}),
    checks: (t.checks as Record<string, unknown>[]).map((check, i) => ({
      run: str(file, check.run, `checks[${i}].run`),
      expectExit: typeof check.expectExit === 'number' ? check.expectExit : 0,
      ...(typeof check.timeoutSec === 'number' ? { timeoutSec: check.timeoutSec } : {}),
    })),
    files: (t.files as Record<string, unknown>[]).map((entry, i) => ({
      path: str(file, entry.path, `files[${i}].path`),
      mustMatch: str(file, entry.mustMatch, `files[${i}].mustMatch`),
    })),
    ...(Array.isArray(t.answer)
      ? {
          answer: (t.answer as Record<string, unknown>[]).map((entry, i) => ({
            mustMatch: str(file, entry.mustMatch, `answer[${i}].mustMatch`),
          })),
        }
      : {}),
    scope: { allow: (scope.allow as unknown[]).map((item, i) => str(file, item, `scope.allow[${i}]`)) },
    budget: {
      maxPromptTokens: num(file, budget.maxPromptTokens, 'budget.maxPromptTokens'),
      maxMinutes: num(file, budget.maxMinutes, 'budget.maxMinutes'),
    },
  };
}

export async function loadTask(file: string): Promise<LoadedTask> {
  const text = await readFile(file, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    fail(file, 'invalid JSON');
  }
  const task = parseTask(file, raw);
  if (path.basename(file, '.json') !== task.id) fail(file, `file name must match id "${task.id}"`);
  return { task, file, taskHash: createHash('sha256').update(text).digest('hex') };
}

/** All tasks of a suite, or the one task with `id` (searched in every suite). Without either, regression and capability. */
export async function loadTasks(
  tasksDir: string,
  select: { suite?: TaskSuite; id?: string },
): Promise<LoadedTask[]> {
  const suites: readonly TaskSuite[] = select.suite
    ? [select.suite]
    : select.id
      ? TASK_SUITES
      : ['regression', 'capability'];
  const out: LoadedTask[] = [];
  for (const suite of suites) {
    let files: string[];
    try {
      files = (await readdir(path.join(tasksDir, suite))).filter((file) => file.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files.sort()) {
      if (select.id && path.basename(file, '.json') !== select.id) continue;
      const loaded = await loadTask(path.join(tasksDir, suite, file));
      if (loaded.task.suite !== suite) fail(loaded.file, `lives in ${suite}/ but says suite "${loaded.task.suite}"`);
      out.push(loaded);
    }
  }
  return out;
}

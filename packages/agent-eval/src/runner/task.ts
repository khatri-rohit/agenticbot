import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export type TaskSuite = 'regression' | 'capability';

/** One eval task (`evals/tasks/<suite>/<id>.json`). Graded on the end state, not the transcript. */
export type EvalTask = {
  id: string;
  suite: TaskSuite;
  repo: { source: string; commit: string };
  prompt: string;
  posture: 'agent' | 'ask';
  checks: { run: string; expectExit: number; timeoutSec?: number }[];
  files: { path: string; mustMatch: string }[];
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
  if (suite !== 'regression' && suite !== 'capability') fail(file, '"suite" must be regression or capability');
  const repo = (t.repo ?? {}) as Record<string, unknown>;
  const scope = (t.scope ?? {}) as Record<string, unknown>;
  const budget = (t.budget ?? {}) as Record<string, unknown>;
  if (!Array.isArray(t.checks)) fail(file, '"checks" must be an array');
  if (!Array.isArray(t.files)) fail(file, '"files" must be an array');
  if (!Array.isArray(scope.allow)) fail(file, '"scope.allow" must be an array');
  const posture = t.posture ?? 'agent';
  if (posture !== 'agent' && posture !== 'ask') fail(file, '"posture" must be agent or ask');
  return {
    id: str(file, t.id, 'id'),
    suite,
    repo: { source: str(file, repo.source, 'repo.source'), commit: str(file, repo.commit, 'repo.commit') },
    prompt: str(file, t.prompt, 'prompt'),
    posture,
    checks: (t.checks as Record<string, unknown>[]).map((check, i) => ({
      run: str(file, check.run, `checks[${i}].run`),
      expectExit: typeof check.expectExit === 'number' ? check.expectExit : 0,
      ...(typeof check.timeoutSec === 'number' ? { timeoutSec: check.timeoutSec } : {}),
    })),
    files: (t.files as Record<string, unknown>[]).map((entry, i) => ({
      path: str(file, entry.path, `files[${i}].path`),
      mustMatch: str(file, entry.mustMatch, `files[${i}].mustMatch`),
    })),
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

/** All tasks of a suite, or the one task with `id` (searched in both suites). */
export async function loadTasks(
  tasksDir: string,
  select: { suite?: TaskSuite; id?: string },
): Promise<LoadedTask[]> {
  const suites: TaskSuite[] = select.suite ? [select.suite] : ['regression', 'capability'];
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

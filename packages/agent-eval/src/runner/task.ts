import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * An eval task definition. Pinned to a repo commit so the same task produces
 * comparable results across harness changes. Stored in evals/tasks/*.json.
 */
export type EvalTask = {
  id: string;
  repo: { source: string; commit: string };
  prompt: string;
  posture: 'workspace' | 'home';
  checks: { run: string; expectExit: number }[];
  files: { path: string; mustMatch?: string; mustExist?: boolean }[];
  scope: { allow: string[] };
  budget: { maxPromptTokens: number; maxMinutes: number };
  /** Default repeat count for stable tasks; 1 until stable. */
  repeat?: number;
};

/**
 * Load a single task from evals/tasks/<id>.json.
 */
export async function loadTask(evalsDir: string, id: string): Promise<EvalTask> {
  const file = path.join(evalsDir, 'tasks', `${id}.json`);
  const raw = await readFile(file, 'utf8');
  return JSON.parse(raw) as EvalTask;
}

/**
 * Load all tasks matching a suite label (e.g. 'core', 'home').
 * Suite = subdirectory under evals/tasks/.
 */
export async function loadSuite(
  evalsDir: string,
  suite: string,
): Promise<EvalTask[]> {
  const suiteDir = path.join(evalsDir, 'tasks', suite);
  let files: string[];
  try {
    files = await readFile(
      path.join(suiteDir, 'index.json'),
      'utf8',
    ).then((raw) => (JSON.parse(raw) as { tasks: string[] }).tasks);
  } catch {
    // No index.json — load all *.json in the suite dir.
    const { readdir } = await import('node:fs/promises');
    try {
      files = (await readdir(suiteDir))
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }

  const tasks: EvalTask[] = [];
  for (const id of files) {
    try {
      tasks.push(await loadTask(evalsDir, `${suite}/${id}`));
    } catch {
      // Skip missing tasks — don't crash the suite.
    }
  }
  return tasks;
}

/**
 * Ensure the evals directory structure exists.
 */
export async function ensureEvalsDir(evalsDir: string): Promise<void> {
  await mkdir(path.join(evalsDir, 'tasks'), { recursive: true });
  await mkdir(path.join(evalsDir, 'baselines'), { recursive: true });
  await mkdir(path.join(evalsDir, 'results'), { recursive: true });
  await mkdir(path.join(evalsDir, 'analyst'), { recursive: true });
  await mkdir(path.join(evalsDir, 'workdirs'), { recursive: true });
}
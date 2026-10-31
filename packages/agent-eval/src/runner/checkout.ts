import { execSync } from 'node:child_process';
import { rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { EvalTask } from './task.js';

/**
 * Check out a pinned commit into a workdir. Uses git worktree when the source
 * is a local path, or git clone for a URL. The workdir is ephemeral and pruned
 * by the runner at start.
 */
export async function checkoutTask(
  task: EvalTask,
  workdir: string,
): Promise<void> {
  await rm(workdir, { recursive: true, force: true });
  await mkdir(workdir, { recursive: true });

  const { source, commit } = task.repo;
  if (source.startsWith('http') || source.startsWith('git@')) {
    execSync(`git clone ${source} ${workdir}`, { stdio: 'pipe' });
    execSync(`git checkout ${commit}`, { cwd: workdir, stdio: 'pipe' });
  } else {
    // Local path — use worktree to avoid touching the source's working tree.
    execSync(`git -C ${source} worktree add --detach ${workdir} ${commit}`, {
      stdio: 'pipe',
    });
  }
}

/**
 * Run a command in the workdir and return its exit code. Used for end-state
 * checks (tests, typecheck, build).
 */
export async function runCheck(
  workdir: string,
  command: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  try {
    const stdout = execSync(command, {
      cwd: workdir,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
    };
  }
}

/**
 * Check file assertions: mustExist and mustMatch (regex against file content).
 */
export async function checkFiles(
  workdir: string,
  files: EvalTask['files'],
): Promise<{ passed: boolean; violations: string[] }> {
  const violations: string[] = [];
  for (const file of files) {
    const fullPath = path.join(workdir, file.path);
    let content: string;
    try {
      content = await readFile(fullPath, 'utf8');
    } catch {
      if (file.mustExist !== false) {
        violations.push(`missing: ${file.path}`);
      }
      continue;
    }
    if (file.mustMatch && !new RegExp(file.mustMatch).test(content)) {
      violations.push(`no match: ${file.path} (expected /${file.mustMatch}/)`);
    }
  }
  return { passed: violations.length === 0, violations };
}

/**
 * Check scope: git diff --name-only must be a subset of scope.allow.
 */
export function checkScope(
  workdir: string,
  allow: string[],
): { passed: boolean; violations: string[] } {
  let changed: string[];
  try {
    changed = execSync('git diff --name-only HEAD', {
      cwd: workdir,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((line) => line.trim());
  } catch {
    return { passed: true, violations: [] };
  }
  const violations = changed.filter((file) => !allow.includes(file));
  return { passed: violations.length === 0, violations };
}
import { lstat, mkdir, readdir, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';

import { exec, git } from './exec.js';

export type Checkout = {
  dir: string;
  /** How dependencies were provided: linked to the source's node_modules, installed, or none needed. */
  deps: 'linked' | 'installed' | 'none';
  depsMs: number;
};

const NPM_CI_TIMEOUT_MS = 20 * 60_000;

function isUrl(source: string): boolean {
  return /^[a-z]+:\/\//i.test(source) || source.startsWith('git@');
}

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([readFile(a), readFile(b)]);
    return left.equals(right);
  } catch {
    return false;
  }
}

/**
 * Remove a workdir. node_modules may be a junction to the main checkout's
 * node_modules: unlink it first so no tool ever recurses into the target.
 */
async function removeWorkdir(sourceRoot: string | null, dir: string): Promise<void> {
  const modules = path.join(dir, 'node_modules');
  try {
    if ((await lstat(modules)).isSymbolicLink()) await rm(modules, { force: true });
  } catch {
    // No node_modules: nothing to unlink.
  }
  if (sourceRoot) await git(sourceRoot, ['worktree', 'remove', '--force', dir]);
  await rm(dir, { recursive: true, force: true });
}

/** Delete earlier workdirs of this task (`<taskId>-<n>`). */
export async function pruneWorkdirs(workdirsRoot: string, taskId: string, source: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(workdirsRoot);
  } catch {
    return;
  }
  const sourceRoot = isUrl(source) ? null : path.resolve(source);
  for (const name of names) {
    if (!name.startsWith(`${taskId}-`)) continue;
    await removeWorkdir(sourceRoot, path.join(workdirsRoot, name));
  }
  if (sourceRoot) await git(sourceRoot, ['worktree', 'prune']);
}

/**
 * A fresh checkout of `source` at `commit` in `dir`, outside the Nx project
 * graph (plan §5). A local source becomes a detached git worktree; a URL is
 * cloned. Dependencies: link the source's node_modules when the lockfiles
 * match (fast), else `npm ci`.
 */
export async function checkout(input: { source: string; commit: string; dir: string }): Promise<Checkout> {
  await mkdir(path.dirname(input.dir), { recursive: true });
  const local = !isUrl(input.source);
  const sourceRoot = local ? path.resolve(input.source) : null;
  await removeWorkdir(sourceRoot, input.dir);
  // A workdir deleted by hand stays registered; `worktree add` would refuse it.
  if (sourceRoot) await git(sourceRoot, ['worktree', 'prune']);

  const created = sourceRoot
    ? await git(sourceRoot, ['worktree', 'add', '--detach', input.dir, input.commit])
    : await git(path.dirname(input.dir), ['clone', '--quiet', input.source, input.dir]);
  if (created.code !== 0) throw new Error(`checkout failed: ${created.out.trim()}`);
  if (!sourceRoot) {
    const detached = await git(input.dir, ['checkout', '--quiet', '--detach', input.commit]);
    if (detached.code !== 0) throw new Error(`checkout of ${input.commit} failed: ${detached.out.trim()}`);
  }

  const lockfile = path.join(input.dir, 'package-lock.json');
  try {
    await lstat(lockfile);
  } catch {
    return { dir: input.dir, deps: 'none', depsMs: 0 };
  }
  const started = Date.now();
  if (sourceRoot && (await sameFile(lockfile, path.join(sourceRoot, 'package-lock.json')))) {
    // A junction needs no admin rights on Windows; a symlink elsewhere.
    await symlink(
      path.join(sourceRoot, 'node_modules'),
      path.join(input.dir, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    return { dir: input.dir, deps: 'linked', depsMs: Date.now() - started };
  }
  const installed = await exec('npm', ['ci', '--no-audit', '--no-fund'], {
    cwd: input.dir,
    shell: true,
    timeoutMs: NPM_CI_TIMEOUT_MS,
  });
  if (installed.code !== 0) throw new Error(`npm ci failed: ${installed.out.trim().slice(-2000)}`);
  return { dir: input.dir, deps: 'installed', depsMs: Date.now() - started };
}

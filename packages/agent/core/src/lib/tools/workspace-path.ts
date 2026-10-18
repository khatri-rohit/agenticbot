import path from 'node:path';
import { realpath } from 'node:fs/promises';

/** True when candidate is the root or a descendant (no `..` escape). */
export function isPathInside(root: string, candidate: string): boolean {
  const from = path.resolve(root);
  const target = path.resolve(candidate);
  const rel = path.relative(from, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * Resolve a user-supplied path against the workspace root.
 * Rejects escapes, including symlink targets that leave the root.
 */
export async function resolveWorkspacePath(
  root: string | undefined,
  requested: string,
): Promise<{ ok: true; abs: string } | { ok: false; error: string }> {
  if (!root?.trim()) {
    return { ok: false, error: 'No workspace is bound to this run' };
  }
  const trimmed = requested.trim();
  if (!trimmed) {
    return { ok: false, error: 'path is required' };
  }

  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch {
    return { ok: false, error: `Workspace root does not exist: ${root}` };
  }

  const candidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(rootReal, trimmed);

  let resolved = candidate;
  try {
    resolved = await realpath(candidate);
  } catch {
    resolved = path.normalize(candidate);
  }

  if (!isPathInside(rootReal, resolved)) {
    return {
      ok: false,
      error: `Path is outside the workspace: ${trimmed}`,
    };
  }
  return { ok: true, abs: resolved };
}

export function toPosixRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

/** Minimal `*`, `**`, `?` matcher on POSIX-relative paths. */
export function globMatch(relPath: string, pattern: string): boolean {
  const normalized = relPath.replaceAll('\\', '/');
  const pat = pattern.replaceAll('\\', '/');
  return globToRegExp(pat).test(normalized);
}

export function globToRegExp(glob: string): RegExp {
  let i = 0;
  let out = '^';
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (glob.startsWith('**', i) && i + 2 === glob.length) {
      out += '.*';
      i += 2;
      continue;
    }
    const ch = glob[i];
    if (ch === '*') {
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if ('\\^$+{}[]()|.'.includes(ch)) out += `\\${ch}`;
    else out += ch;
    i += 1;
  }
  out += '$';
  return new RegExp(out, 'i');
}

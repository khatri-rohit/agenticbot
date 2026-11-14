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

  const resolved = await resolveExistingPrefix(candidate);

  if (!isPathInside(rootReal, resolved)) {
    return {
      ok: false,
      error: `Path is outside the workspace: ${trimmed}`,
    };
  }
  return { ok: true, abs: resolved };
}

/** realpath the longest existing prefix so create paths follow dir symlinks. */
async function resolveExistingPrefix(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    /* not found — walk parents */
  }
  const missing: string[] = [];
  let current = path.normalize(candidate);
  while (true) {
    missing.unshift(path.basename(current));
    const parent = path.dirname(current);
    if (parent === current) return path.normalize(candidate);
    try {
      const parentReal = await realpath(parent);
      return path.join(parentReal, ...missing);
    } catch {
      current = parent;
    }
  }
}

export function toPosixRelative(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

/**
 * Glob matcher on POSIX-relative paths: `*`, `**`, `?`, `[abc]` / `[!abc]`
 * classes and `{a,b}` alternatives (nestable), case-insensitive. Models write
 * brace lists like `*.{ts,tsx}` and classes like `*[Dd]ashboard*` as a matter
 * of course; matching them literally returned "no files" for files that exist.
 */
export function globMatch(relPath: string, pattern: string): boolean {
  const normalized = relPath.replaceAll('\\', '/');
  const pat = pattern.replaceAll('\\', '/');
  return globToRegExp(pat).test(normalized);
}

export function globToRegExp(glob: string): RegExp {
  return new RegExp(`^${globBody(glob)}$`, 'i');
}

const REGEX_SPECIAL = '\\^$+{}[]()|.';

function globBody(glob: string): string {
  let i = 0;
  let out = '';
  // Open `{` groups: a `,` inside one is an alternative.
  let depth = 0;
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
    const ch = glob[i]!;
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
    if (ch === '[') {
      const close = glob.indexOf(']', i + 2);
      if (close > i) {
        let body = glob.slice(i + 1, close);
        const negate = body.startsWith('!') || body.startsWith('^');
        if (negate) body = body.slice(1);
        const escaped = body.replace(/[\\\]^]/g, (c) => `\\${c}`);
        out += negate ? `[^/${escaped}]` : `[${escaped}]`;
        i = close + 1;
        continue;
      }
    }
    if (ch === '{' && hasClosingBrace(glob, i)) {
      out += '(?:';
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === '}' && depth > 0) {
      out += ')';
      depth -= 1;
      i += 1;
      continue;
    }
    if (ch === ',' && depth > 0) {
      out += '|';
      i += 1;
      continue;
    }
    out += REGEX_SPECIAL.includes(ch) ? `\\${ch}` : ch;
    i += 1;
  }
  return out;
}

/** A `{` opens a group only when a matching `}` follows; otherwise it is literal. */
function hasClosingBrace(glob: string, from: number): boolean {
  let depth = 0;
  for (let j = from; j < glob.length; j++) {
    if (glob[j] === '{') depth += 1;
    else if (glob[j] === '}' && --depth === 0) return true;
  }
  return false;
}

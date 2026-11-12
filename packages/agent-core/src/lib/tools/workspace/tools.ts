import { spawn } from 'node:child_process';
import {
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import path from 'node:path';

import type { Tool } from '../types';
import { isOutboundHttpShellCommand } from '../web/trust';
import {
  globMatch,
  isPathInside,
  resolveWorkspacePath,
  toPosixRelative,
} from './path';

/** M4a: cap tool payloads before they hit the ledger (large bodies spill to blobs there). */
/**
 * Read window. Sized against the cost of a model call, not of one result:
 * at a ~36k-token prompt, a 40k-char (~10k-token) read that saves even one
 * follow-up call pays for itself several times over.
 */
export const WORKSPACE_READ_MAX_CHARS = 40_000;
export const WORKSPACE_READ_MAX_LINES = 2_000;
export const WORKSPACE_READ_MAX_LOAD_BYTES = 1_000_000;
export const WORKSPACE_TERMINAL_MAX_CHARS = 8_000;
export const WORKSPACE_TERMINAL_TIMEOUT_MS = 120_000;
export const WORKSPACE_GREP_MAX_MATCHES = 100;
export const WORKSPACE_GREP_LINE_MAX_CHARS = 200;
/** Room for context lines; a cut search sends the model back for another. */
export const WORKSPACE_GREP_MAX_CHARS = 12_000;

/**
 * Largest result the live prompt keeps for a tool that sizes its own output
 * (header and note slack included). The generic live cap must not cut a
 * result again after the tool already chose its window.
 */
export function liveResultCapChars(toolName: string | undefined, fallback: number): number {
  if (toolName === 'read_file') return Math.max(fallback, WORKSPACE_READ_MAX_CHARS + 1_000);
  if (toolName === 'grep') return Math.max(fallback, WORKSPACE_GREP_MAX_CHARS + 500);
  return fallback;
}
/** Upper bound for grep `context`; wider windows are what read_file is for. */
export const WORKSPACE_GREP_MAX_CONTEXT = 5;
export const WORKSPACE_GLOB_MAX_RESULTS = 200;
export const WORKSPACE_WALK_MAX_FILES = 2_000;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  '.next',
  'coverage',
  '.nx',
  '.turbo',
]);

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function replaceOnce(
  haystack: string,
  needle: string,
  replacement: string,
): string {
  const index = haystack.indexOf(needle);
  if (index < 0) return haystack;
  return (
    haystack.slice(0, index) +
    replacement +
    haystack.slice(index + needle.length)
  );
}

function truncated(text: string, max: number, label: string): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n(${label} truncated at ${max} chars)`;
}

const EDIT_HUNK_MAX_CHARS = 1_200;

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

function clipHunk(text: string): string {
  if (text.length <= EDIT_HUNK_MAX_CHARS) return text;
  return `${text.slice(0, EDIT_HUNK_MAX_CHARS)}\n(hunk truncated)`;
}

function formatEditReport(input: {
  action: 'created' | 'patched';
  relPath: string;
  before: string;
  after: string;
  removed?: string;
  added?: string;
}): string {
  const beforeLines = lineCount(input.before);
  const afterLines = lineCount(input.after);
  const delta = afterLines - beforeLines;
  const deltaLabel = delta === 0 ? '0' : delta > 0 ? `+${delta}` : String(delta);
  const header = [
    `${input.action === 'created' ? 'Created' : 'Patched'} ${input.relPath}`,
    input.action === 'created'
      ? 'uniqueness: n/a (created)'
      : 'uniqueness: ok (1 match)',
    `lines: ${beforeLines} → ${afterLines} (${deltaLabel})`,
    `bytes: ${Buffer.byteLength(input.before)} → ${Buffer.byteLength(input.after)}`,
  ];
  if (input.action === 'created') {
    return `${header.join('\n')}\n\n--- added ---\n${clipHunk(input.after)}`;
  }
  return `${header.join('\n')}\n\n--- removed ---\n${clipHunk(input.removed ?? '')}\n\n--- added ---\n${clipHunk(input.added ?? '')}`;
}

/** Minimal deny list. Full sandbox is a later wave. */
function deniedTerminalCommand(command: string): string | null {
  const compact = command.trim();
  if (!compact) return 'command is required';
  const tests: { pattern: RegExp; reason: string }[] = [
    { pattern: /\brm\s+-[a-zA-Z]*f[a-zA-Z]*\s+\/(\s|$)/, reason: 'refuses rm -rf /' },
    { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\/(\s|$)/, reason: 'refuses rm -rf /' },
    { pattern: /\bmkfs(\.| )/i, reason: 'refuses mkfs' },
    { pattern: /\bformat\s+[a-z]:/i, reason: 'refuses disk format' },
    {
      pattern: /\bdd\s+.*\bof\s*=\s*\/dev\//i,
      reason: 'refuses dd to a device',
    },
    // Read/search via shell bypasses path-jailed glob/grep/read_file.
    {
      pattern: /(^|[;&|]\s*)(cat|head|tail|less|more)\s+/i,
      reason: 'use read_file / grep / glob instead of shell readers',
    },
    {
      pattern: /\bGet-Content\b/i,
      reason: 'use read_file instead of Get-Content',
    },
    {
      pattern: /(^|[;&|]\s*)type\s+\S+/i,
      reason: 'use read_file instead of type',
    },
    // Write via shell bypasses path-jailed edit_file and its change report.
    {
      pattern:
        /\bnode\b[^;&|]*\s-(e|p)\b[^;&|]*(writeFile|writeFileSync|appendFile|appendFileSync|rmSync|unlinkSync|mkdirSync|rmdirSync)/i,
      reason: 'writes go through edit_file, not shell scripts',
    },
    {
      pattern: /\bsed\s+(-[a-zA-Z]*i[a-zA-Z]*\s|--in-place)/,
      reason: 'writes go through edit_file, not sed -i',
    },
    {
      pattern: /(^|[;&|]\s*)tee\s+[^;&|]*>/,
      reason: 'writes go through edit_file, not tee',
    },
    {
      pattern: /(^|[;&|]\s*)tee\s+(-a\s+)?\S+/,
      reason: 'writes go through edit_file, not tee',
    },
    {
      pattern: /(^|[;&|]\s*)out-file\s+\S+/i,
      reason: 'writes go through edit_file, not Out-File',
    },
    {
      pattern: /(^|[;&|]\s*)set-content\s+\S+/i,
      reason: 'writes go through edit_file, not Set-Content',
    },
    {
      pattern: /(^|[;&|]\s*)add-content\s+\S+/i,
      reason: 'writes go through edit_file, not Add-Content',
    },
  ];
  for (const test of tests) {
    if (test.pattern.test(compact)) return test.reason;
  }
  if (isOutboundHttpShellCommand(compact)) {
    return 'refuses outbound HTTP from the shell; use web_fetch / web_search';
  }
  return null;
}

async function readTextCapped(abs: string): Promise<string> {
  const handle = await open(abs, 'r');
  try {
    const { size } = await handle.stat();
    const load = Math.min(size, WORKSPACE_READ_MAX_LOAD_BYTES);
    const buf = Buffer.alloc(load);
    await handle.read(buf, 0, load, 0);
    return buf.toString('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * Walk files under root. Symlinks/junctions whose realpath leaves the root are
 * skipped (same jail as resolveWorkspacePath). `root` should already be realpath'd.
 */
async function walkFiles(
  rootReal: string,
  signal: AbortSignal | undefined,
  acc: string[],
): Promise<void> {
  const stack = [rootReal];
  while (stack.length > 0) {
    if (signal?.aborted) throw new Error('Run cancelled');
    if (acc.length >= WORKSPACE_WALK_MAX_FILES) return;
    const dir = stack.pop();
    if (!dir) return;
    let entries: Dirent[] = [];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (acc.length >= WORKSPACE_WALK_MAX_FILES) return;
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;

      const abs = path.join(dir, entry.name);
      let real: string;
      try {
        real = await realpath(abs);
      } catch {
        continue;
      }
      if (!isPathInside(rootReal, real)) continue;

      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(real);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        stack.push(real);
        continue;
      }
      if (info.isFile()) acc.push(real);
    }
  }
}

async function workspaceRootReal(
  root: string | undefined,
): Promise<string | null> {
  if (!root?.trim()) return null;
  try {
    return await realpath(root);
  } catch {
    return null;
  }
}

export const globTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'glob',
      description:
        'Find files in the open workspace folder by glob pattern (e.g. **/*.ts). Returns relative paths.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Glob relative to the workspace root. Default **/*',
          },
        },
        additionalProperties: false,
      },
    },
  },
  guidance: {
    whenToUse: [
      'You need to locate files in the open project before reading or editing them.',
    ],
    whenNotToUse: [
      'You already know the exact relative path — use read_file or grep.',
    ],
    usage: [
      'Pass a glob like **/*.ts or src/**/*.tsx.',
      'Build a working set of paths, then read_file those files before edit_file.',
      'Results are relative to the workspace root and capped.',
    ],
  },
  risk: 'read',
  stage: 'read',
  execute: async (args, ctx) => {
    const root = await workspaceRootReal(ctx.workspaceRoot);
    if (!root) return 'No workspace is bound to this run';
    const pattern = asString(args.pattern).trim() || '**/*';
    const files: string[] = [];
    await walkFiles(root, ctx.signal, files);
    const matches: string[] = [];
    for (const abs of files) {
      const rel = toPosixRelative(root, abs);
      if (!globMatch(rel, pattern)) continue;
      matches.push(rel);
      if (matches.length >= WORKSPACE_GLOB_MAX_RESULTS) break;
    }
    if (matches.length === 0) return `(no files matched ${pattern})`;
    const extra =
      files.length >= WORKSPACE_WALK_MAX_FILES
        ? `\n(walk stopped at ${WORKSPACE_WALK_MAX_FILES} files)`
        : '';
    return `${matches.join('\n')}${extra}`;
  },
};

export const grepTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search file contents in the open workspace. Returns path:line:text matches.',
      parameters: {
        type: 'object',
        properties: {
          pattern: {
            type: 'string',
            description: 'Literal or regex (JavaScript) to find.',
          },
          glob: {
            type: 'string',
            description: 'Optional file glob to limit the search.',
          },
          context: {
            type: 'integer',
            description: `Lines of surrounding context per match (0–${WORKSPACE_GREP_MAX_CONTEXT}). Default 0.`,
          },
        },
        required: ['pattern'],
        additionalProperties: false,
      },
    },
  },
  guidance: {
    whenToUse: [
      'You need to find a symbol, error string, or unique span before editing.',
    ],
    whenNotToUse: ['The exact file path and contents are already in context.'],
    usage: [
      'Use a specific pattern. Optionally pass glob to skip unrelated files.',
      'Pass context (e.g. 3) to see the lines around each match; often that replaces a follow-up read_file.',
      'Matches print as path:line:text, context lines as path-line-text, groups split by --.',
      'Then read_file the hits you need. Do not edit a path you have not seen.',
    ],
  },
  risk: 'read',
  stage: 'read',
  execute: async (args, ctx) => {
    const root = await workspaceRootReal(ctx.workspaceRoot);
    if (!root) return 'No workspace is bound to this run';
    const pattern = asString(args.pattern);
    if (!pattern) return 'pattern is required';
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      return `Invalid pattern: ${pattern}`;
    }
    const fileGlob = asString(args.glob).trim();
    const context =
      typeof args.context === 'number' && Number.isFinite(args.context)
        ? Math.min(WORKSPACE_GREP_MAX_CONTEXT, Math.max(0, Math.floor(args.context)))
        : 0;
    const files: string[] = [];
    await walkFiles(root, ctx.signal, files);
    const rows: string[] = [];
    let matches = 0;
    let chars = 0;
    const clipLine = (text: string) =>
      text.length > WORKSPACE_GREP_LINE_MAX_CHARS
        ? `${text.slice(0, WORKSPACE_GREP_LINE_MAX_CHARS)}…`
        : text;
    const push = (row: string): boolean => {
      rows.push(row);
      chars += row.length + 1;
      return chars >= WORKSPACE_GREP_MAX_CHARS;
    };
    const truncated = () =>
      `${rows.join('\n')}\n(grep truncated at ${WORKSPACE_GREP_MAX_MATCHES} matches / ${WORKSPACE_GREP_MAX_CHARS} chars)`;
    for (const abs of files) {
      if (ctx.signal.aborted) return 'Run cancelled';
      const rel = toPosixRelative(root, abs);
      if (fileGlob && !globMatch(rel, fileGlob)) continue;
      let text: string;
      try {
        text = await readFile(abs, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue;
      const lines = text.split('\n');
      // Last line index already printed in this file, so overlapping
      // context windows print each line once (rg -C style).
      let printedThrough = -1;
      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i])) continue;
        const from = Math.max(0, i - context, printedThrough + 1);
        const to = Math.min(lines.length - 1, i + context);
        if (context > 0 && rows.length > 0 && from > printedThrough + 1) {
          if (push('--')) return truncated();
        }
        for (let j = from; j <= to; j++) {
          const sep = j === i || regex.test(lines[j]) ? ':' : '-';
          if (push(`${rel}${sep}${j + 1}${sep}${clipLine(lines[j])}`)) return truncated();
        }
        printedThrough = Math.max(printedThrough, to);
        matches += 1;
        if (matches >= WORKSPACE_GREP_MAX_MATCHES) return truncated();
      }
    }
    return rows.length > 0 ? rows.join('\n') : `(no matches for ${pattern})`;
  },
};

export const readFileTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description: `Read a text file inside the open workspace. Returns the whole file when it fits (up to ${WORKSPACE_READ_MAX_LINES} lines / ${WORKSPACE_READ_MAX_CHARS} chars); larger files return a window from offset.`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path relative to the workspace root.',
          },
          offset: {
            type: 'integer',
            description: '1-based start line. Default 1.',
          },
          limit: {
            type: 'integer',
            description: 'Max lines to return.',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
  },
  guidance: {
    whenToUse: [
      'You need the contents of a known file before editing or answering.',
    ],
    whenNotToUse: ['The file is outside the open folder — that is blocked.'],
    usage: [
      'Pass a relative path from glob/grep.',
      'Read before edit_file so oldText is a unique span from this file.',
      'Output starts with [lines a–b of N]; it is not file content. A cut read names the offset to continue from.',
      'Read the whole file: omit offset and limit. A file that fits is returned whole anyway, so slices only add calls.',
      'Only for a file larger than the window: grep for the anchor line (grep returns path:line), then read from that offset.',
    ],
  },
  risk: 'read',
  stage: 'read',
  execute: async (args, ctx) => {
    const resolved = await resolveWorkspacePath(
      ctx.workspaceRoot,
      asString(args.path),
    );
    if (!resolved.ok) return resolved.error;
    let text: string;
    try {
      text = await readTextCapped(resolved.abs);
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT')
        return `File not found: ${asString(args.path)}`;
      return `Failed to read file: ${err.message}`;
    }
    return formatFileRead(text, args.offset, args.limit);
  },
};

/**
 * Windows narrower than this are widened on files too large to return
 * whole: every extra call re-sends the whole prompt, which costs far more
 * than the extra lines.
 */
export const WORKSPACE_READ_MIN_LINES = 200;

/**
 * read_file result: a `[lines a–b of N]` header, then the raw lines (no
 * per-line numbers, so spans copy cleanly into edit_file oldText). Cuts on a
 * line boundary and names the offset to continue from.
 *
 * The unit of a read is the file: when the whole file fits the read window
 * (WORKSPACE_READ_MAX_LINES lines and WORKSPACE_READ_MAX_CHARS chars) it is
 * returned whole, whatever offset/limit asked for. Slicing a file that fits
 * only multiplies model calls (each re-sends the prompt) for no saving.
 */
export function formatFileRead(
  text: string,
  offsetRaw: unknown,
  limitRaw: unknown,
): string {
  const partial = Buffer.byteLength(text, 'utf8') >= WORKSPACE_READ_MAX_LOAD_BYTES;
  const all = text.split('\n');
  // A trailing newline ends the last line; it does not start another.
  const total = text.endsWith('\n') ? all.length - 1 : all.length;
  const of = `${total}${partial ? '+ (file larger than the 1 MB read window)' : ''}`;
  if (text.length === 0) return '[empty file]';

  const fitsWhole =
    !partial &&
    total <= WORKSPACE_READ_MAX_LINES &&
    text.length <= WORKSPACE_READ_MAX_CHARS;
  const askedOffset =
    typeof offsetRaw === 'number' && offsetRaw > 1 ? Math.floor(offsetRaw) : 1;
  const offset = fitsWhole ? 1 : askedOffset;
  if (offset > total) {
    return `[offset ${offset} is past end of file (${of} lines)]`;
  }
  const requested =
    !fitsWhole && typeof limitRaw === 'number' && limitRaw > 0
      ? Math.floor(limitRaw)
      : total;
  const limit = Math.min(
    WORKSPACE_READ_MAX_LINES,
    Math.max(requested, WORKSPACE_READ_MIN_LINES),
  );
  const start = offset - 1;
  const end = Math.min(total, start + limit);

  const first = all[start] ?? '';
  if (first.length > WORKSPACE_READ_MAX_CHARS) {
    const next = offset < total ? `\n\n(continue with offset=${offset + 1})` : '';
    return `[line ${offset} of ${of}; line cut at ${WORKSPACE_READ_MAX_CHARS} chars]\n${first.slice(0, WORKSPACE_READ_MAX_CHARS)}${next}`;
  }

  const kept: string[] = [];
  let chars = 0;
  for (let i = start; i < end; i++) {
    const line = all[i] ?? '';
    if (kept.length > 0 && chars + line.length + 1 > WORKSPACE_READ_MAX_CHARS) break;
    kept.push(line);
    chars += line.length + 1;
  }
  const last = start + kept.length;
  const header = `[lines ${offset}–${last} of ${of}]`;
  const footer =
    last < end
      ? `\n\n(read_file truncated at line ${last} of ${of} — continue with offset=${last + 1})`
      : last < total
        ? `\n\n(window ends at line ${last} of ${of} — continue with offset=${last + 1})`
        : '';
  return `${header}\n${kept.join('\n')}${footer}`;
}

/** edit_file results start with "Created" or "Patched" on success (see the change report above). */
export function isEditSuccess(result: string): boolean {
  return result.startsWith('Created') || result.startsWith('Patched');
}

export const editFileTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Create or patch a file in the workspace. Patches require a unique oldText span (matches exactly once).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Path relative to the workspace root.',
          },
          oldText: {
            type: 'string',
            description:
              'Exact unique span to replace. Omit only when creating a new file.',
          },
          newText: {
            type: 'string',
            description: 'Replacement text, or full contents when creating.',
          },
        },
        required: ['path', 'newText'],
        additionalProperties: false,
      },
    },
  },
  guidance: {
    whenToUse: ['You need to change or create a file in the open project.'],
    whenNotToUse: [
      'You have not read the file and cannot quote a unique span.',
      'The path is not in the working set from glob, grep, or a prior read.',
    ],
    usage: [
      'For existing files, oldText must match exactly once.',
      'For a new file, omit oldText and pass newText as the full contents.',
      'The result is a change report (path, created or patched, line/byte delta, hunk). Read it before the next step.',
    ],
  },
  risk: 'write',
  // newText/oldText would swamp the label; path and intent say enough.
  previewArgs: (args) => ({
    path: typeof args.path === 'string' ? args.path : '',
    intent: typeof args.oldText === 'string' && args.oldText.length > 0 ? 'patch' : 'create',
  }),
  classify: (result) => ({ outcome: isEditSuccess(result) ? 'ok' : 'error' }),
  execute: async (args, ctx) => {
    const resolved = await resolveWorkspacePath(
      ctx.workspaceRoot,
      asString(args.path),
    );
    if (!resolved.ok) return resolved.error;
    const newText = asString(args.newText);
    const oldText = asString(args.oldText);
    let existing: string | null = null;
    try {
      existing = await readFile(resolved.abs, 'utf8');
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        return `Failed to read file: ${err.message}`;
      }
    }

    const relPath = asString(args.path);
    if (existing === null) {
      if (oldText) return 'File not found; omit oldText to create it';
      await mkdir(path.dirname(resolved.abs), { recursive: true });
      await writeFile(resolved.abs, newText, 'utf8');
      return formatEditReport({
        action: 'created',
        relPath,
        before: '',
        after: newText,
      });
    }

    if (!oldText) {
      return 'oldText is required to patch an existing file (must match exactly once)';
    }
    // EOL-flexible match: the model's span may use LF while the file on disk
    // is CRLF (git autocrlf). Match on normalized text, splice in the file's
    // own EOL style so the edit never rewrites line endings.
    const hasCrlf = existing.includes('\r\n');
    // Detect a bare LF that is not part of a CRLF pair (mixed line endings).
    const hasBareLf = hasCrlf
      ? existing.replace(/\r\n/g, '').includes('\n')
      : existing.includes('\n');
    // Mixed-EOL file: normalizing then re-expanding would rewrite every line
    // to one style. Fall back to exact match on the original string.
    if (hasCrlf && hasBareLf) {
      const exactCount = existing.split(oldText).length - 1;
      if (exactCount === 0) {
        return `oldText span not found in ${relPath}. Re-read the file and copy an exact unique span.`;
      }
      if (exactCount > 1) {
        return `oldText span matches ${exactCount} times in ${relPath}. Re-read the file and use a longer unique span.`;
      }
      const next = replaceOnce(existing, oldText, newText);
      await writeFile(resolved.abs, next, 'utf8');
      return formatEditReport({
        action: 'patched',
        relPath,
        before: existing,
        after: next,
        removed: oldText,
        added: newText,
      });
    }
    const fileEol = hasCrlf ? '\r\n' : '\n';
    const normalized = existing.replace(/\r\n/g, '\n');
    const normalizedOld = oldText.replace(/\r\n/g, '\n');
    const normalizedNew = newText.replace(/\r\n/g, '\n');
    const count = normalized.split(normalizedOld).length - 1;
    if (count === 0) {
      return `oldText span not found in ${relPath}. Re-read the file and copy an exact unique span.`;
    }
    if (count > 1) {
      return `oldText span matches ${count} times in ${relPath}. Re-read the file and use a longer unique span.`;
    }
    const next = replaceOnce(
      normalized,
      normalizedOld,
      normalizedNew,
    ).replace(/\n/g, fileEol);
    await writeFile(resolved.abs, next, 'utf8');
    return formatEditReport({
      action: 'patched',
      relPath,
      before: existing,
      after: next,
      removed: oldText,
      added: newText,
    });
  },
};

export const runTerminalTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'run_terminal',
      description:
        'Run a command in the open workspace folder (compile, test, build, etc.). cwd is always the workspace root. Output is capped.',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to run in the workspace root.',
          },
        },
        required: ['command'],
        additionalProperties: false,
      },
    },
  },
  guidance: {
    whenToUse: [
      'You need that project’s compile, test, build, or other scripts after an edit.',
    ],
    whenNotToUse: [
      'Reading, searching, or dumping files — use glob, grep, and read_file instead.',
      'Commands that target a different repo or parent directory.',
    ],
    usage: [
      'cwd is the open folder. Do not cd to a parent of the workspace.',
      'Use the project’s real commands (from AGENTS.md, package scripts, Makefile, cargo, pytest, …).',
      'Do not cat/type/Get-Content/head/tail files; those are blocked — use read_file.',
      'The result includes cwd, exit code, and capped stdout/stderr. Use that to repair.',
    ],
  },
  risk: 'exec',
  stage: 'exec',
  // Kills the whole process tree on its own timeout.
  ownsTimeout: true,
  // The second line is `exit <n>`, `exit timeout` or `signal <name>`; blocked and unbound runs return one line.
  classify: (result) => {
    const exit = /^exit (\d+)$/.exec(result.split('\n', 2)[1] ?? '');
    return exit ? { outcome: 'ok', exitCode: Number(exit[1]) } : { outcome: 'error' };
  },
  execute: async (args, ctx) => {
    const root = ctx.workspaceRoot;
    if (!root) return 'No workspace is bound to this run';
    const command = asString(args.command).trim();
    const denied = deniedTerminalCommand(command);
    if (denied) return `Command blocked: ${denied}`;
    return runWorkspaceCommand(command, root, ctx.signal);
  },
};

function killProcessTree(pid: number): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function runWorkspaceCommand(
  command: string,
  cwd: string,
  signal: AbortSignal,
  maxChars = WORKSPACE_TERMINAL_MAX_CHARS,
  timeoutMs = WORKSPACE_TERMINAL_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Run cancelled'));
      return;
    }
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let combined = '';
    let truncatedOut = false;
    let settled = false;
    const append = (chunk: Buffer | string) => {
      if (truncatedOut) return;
      combined += chunk.toString();
      if (combined.length > maxChars) {
        combined = combined.slice(0, maxChars);
        truncatedOut = true;
      }
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    const bodyText = () =>
      truncatedOut
        ? `${combined}\n\n(run_terminal truncated at ${maxChars} chars)`
        : combined;

    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value ?? '');
    };

    const onAbort = () => {
      if (child.pid) killProcessTree(child.pid);
      finish(new Error('Run cancelled'));
    };

    const timer = setTimeout(() => {
      if (child.pid) killProcessTree(child.pid);
      finish(
        undefined,
        `cwd: ${cwd}\nexit timeout\n${bodyText()}\n\n(run_terminal killed after ${timeoutMs}ms)`.trimEnd(),
      );
    }, timeoutMs);

    signal.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => finish(error));
    child.on('close', (code, killSignal) => {
      if (signal.aborted) {
        finish(new Error('Run cancelled'));
        return;
      }
      const status =
        killSignal != null ? `signal ${killSignal}` : `exit ${code ?? 0}`;
      finish(undefined, `cwd: ${cwd}\n${status}\n${bodyText()}`.trimEnd());
    });
  });
}

export const WORKSPACE_DIFF_MAX_CHARS = 12_000;

/** git with fixed args (no shell), cwd jailed to the workspace root. */
function runGit(
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<{ code: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, windowsHide: true });
    let out = '';
    const onAbort = () => child.kill();
    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      if (out.length < WORKSPACE_DIFF_MAX_CHARS * 2) out += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (out.length < WORKSPACE_DIFF_MAX_CHARS * 2) out += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort);
      resolve({ code: code ?? 0, out });
    });
  });
}

export const diffTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'diff',
      description:
        'Show uncommitted changes in the open workspace: git diff against HEAD (staged + unstaged) and untracked files. Read-only.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Optional file or folder (relative) to limit the diff.',
          },
        },
        additionalProperties: false,
      },
    },
  },
  guidance: {
    whenToUse: ['You need to see what changed in the working tree (review, final summary).'],
    whenNotToUse: ['To read a file — use read_file.'],
    usage: ['Output is capped; pass path to narrow a large diff.'],
  },
  risk: 'read',
  stage: 'read',
  execute: async (args, ctx) => {
    const root = await workspaceRootReal(ctx.workspaceRoot);
    if (!root) return 'No workspace is bound to this run';
    let target = '.';
    const requested = asString(args.path).trim();
    if (requested) {
      const resolved = await resolveWorkspacePath(ctx.workspaceRoot, requested);
      if (!resolved.ok) return resolved.error;
      target = toPosixRelative(root, resolved.abs) || '.';
    }
    try {
      // A repo with no commits has no HEAD: show staged + unstaged instead.
      const hasHead =
        (await runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], ctx.signal)).code === 0;
      const diffOf = async (extra: string[]) => {
        if (hasHead) return runGit(root, ['diff', 'HEAD', '--no-color', ...extra, '--', target], ctx.signal);
        const staged = await runGit(root, ['diff', '--cached', '--no-color', ...extra, '--', target], ctx.signal);
        if (staged.code !== 0) return staged;
        const unstaged = await runGit(root, ['diff', '--no-color', ...extra, '--', target], ctx.signal);
        return { ...unstaged, out: [staged.out.trim(), unstaged.out.trim()].filter(Boolean).join('\n') };
      };
      const stat = await diffOf(['--stat']);
      if (stat.code !== 0) return `git diff failed: ${stat.out.trim() || `exit ${stat.code}`}`;
      const body = await diffOf([]);
      const untracked = await runGit(
        root,
        ['ls-files', '--others', '--exclude-standard', '--', target],
        ctx.signal,
      );
      const parts = [
        stat.out.trim() || '(no tracked changes)',
        untracked.out.trim() ? `Untracked files:\n${untracked.out.trim()}` : '',
        body.out.trim(),
      ].filter(Boolean);
      return truncated(parts.join('\n\n'), WORKSPACE_DIFF_MAX_CHARS, 'diff');
    } catch (error) {
      return `git diff failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
};

export const WORKSPACE_TOOLS: Tool[] = [
  globTool,
  grepTool,
  readFileTool,
  editFileTool,
  runTerminalTool,
  diffTool,
];

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

import type { Tool } from './type';
import {
  globMatch,
  isPathInside,
  resolveWorkspacePath,
  toPosixRelative,
} from './workspace-path';

/** M4a: cap tool payloads before they hit the ledger. Stay under assembler stub (8k). */
export const WORKSPACE_READ_MAX_CHARS = 7_000;
export const WORKSPACE_READ_MAX_LOAD_BYTES = 1_000_000;
export const WORKSPACE_TERMINAL_MAX_CHARS = 8_000;
export const WORKSPACE_TERMINAL_TIMEOUT_MS = 120_000;
export const WORKSPACE_GREP_MAX_MATCHES = 50;
export const WORKSPACE_GREP_LINE_MAX_CHARS = 200;
export const WORKSPACE_GREP_MAX_CHARS = 7_000;
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
  ];
  for (const test of tests) {
    if (test.pattern.test(compact)) return test.reason;
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
      'Then read_file the hits you need. Do not edit a path you have not seen.',
    ],
  },
  risk: 'read',
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
    const files: string[] = [];
    await walkFiles(root, ctx.signal, files);
    const hits: string[] = [];
    let chars = 0;
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
      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i])) continue;
        const line =
          lines[i].length > WORKSPACE_GREP_LINE_MAX_CHARS
            ? `${lines[i].slice(0, WORKSPACE_GREP_LINE_MAX_CHARS)}…`
            : lines[i];
        const row = `${rel}:${i + 1}:${line}`;
        hits.push(row);
        chars += row.length + 1;
        if (
          hits.length >= WORKSPACE_GREP_MAX_MATCHES ||
          chars >= WORKSPACE_GREP_MAX_CHARS
        ) {
          return `${hits.join('\n')}\n(grep truncated at ${WORKSPACE_GREP_MAX_MATCHES} matches / ${WORKSPACE_GREP_MAX_CHARS} chars)`;
        }
      }
    }
    return hits.length > 0 ? hits.join('\n') : `(no matches for ${pattern})`;
  },
};

export const readFileTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file inside the open workspace. Large files are truncated.',
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
      'Use offset/limit for large files; output is hard-capped.',
    ],
  },
  risk: 'read',
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
    const offsetRaw = args.offset;
    const limitRaw = args.limit;
    const offset =
      typeof offsetRaw === 'number' && offsetRaw > 1
        ? Math.floor(offsetRaw)
        : 1;
    const lines = text.split('\n');
    const start = Math.min(offset - 1, lines.length);
    const limit =
      typeof limitRaw === 'number' && limitRaw > 0
        ? Math.floor(limitRaw)
        : lines.length;
    const slice = lines.slice(start, start + limit).join('\n');
    return truncated(slice, WORKSPACE_READ_MAX_CHARS, 'read_file');
  },
};

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
    const count = existing.split(oldText).length - 1;
    if (count === 0) return 'oldText span not found';
    if (count > 1) return 'oldText span is not unique';
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
      'Commands that target a different repo or parent directory.',
    ],
    usage: [
      'cwd is the open folder. Do not cd to a parent of the workspace.',
      'Use the project’s real commands (from AGENTS.md, package scripts, Makefile, cargo, pytest, …).',
      'The result includes cwd, exit code, and capped stdout/stderr. Use that to repair.',
    ],
  },
  risk: 'exec',
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

export const WORKSPACE_TOOLS: Tool[] = [
  globTool,
  grepTool,
  readFileTool,
  editFileTool,
  runTerminalTool,
];

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { globMatch } from './path';
import {
  formatFileRead,
  stripReadNumbers,
  createOutputCapture,
  terminalShellNote,
  terminalTimeoutMs,
  WORKSPACE_READ_MAX_CHARS,
  WORKSPACE_READ_MIN_LINES,
  WORKSPACE_TOOLS,
  liveResultCapChars,
} from './tools';

function ctx(workspaceRoot: string) {
  return {
    runId: 'r1',
    threadId: 't1',
    origin: 'eval' as const,
    signal: new AbortController().signal,
    workspaceRoot,
  };
}

describe('edit_file unique span', () => {
  const editFile = WORKSPACE_TOOLS.find(
    (tool) => tool.definition.function.name === 'edit_file',
  );

  it('rejects a span that is not unique and does not write', async () => {
    expect(editFile).toBeDefined();
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-edit-'));
    const rel = 'dup.ts';
    const original = 'const x = 1;\nconst x = 1;\n';
    await writeFile(path.join(root, rel), original, 'utf8');
    const result = await editFile?.execute(
      { path: rel, oldText: 'const x = 1;', newText: 'const x = 2;' },
      ctx(root),
    );
    expect(result).toMatch(/matches 2 times/);
    expect(result).toMatch(/Re-read/);
    expect(await readFile(path.join(root, rel), 'utf8')).toBe(original);
  });

  it('rejects a span that is missing', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-edit-'));
    await writeFile(path.join(root, 'a.ts'), 'hello\n', 'utf8');
    const result = await editFile?.execute(
      { path: 'a.ts', oldText: 'missing', newText: 'nope' },
      ctx(root),
    );
    expect(result).toMatch(/not found/);
  });

  it('strips read_file line numbers pasted into oldText and newText', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-edit-'));
    await writeFile(path.join(root, 'a.ts'), 'one\n\ntwo\nthree\n', 'utf8');
    const result = await editFile?.execute(
      { path: 'a.ts', oldText: '1\tone\n2\t\n3\ttwo', newText: '1\tONE\n2\t\n3\tTWO' },
      ctx(root),
    );
    expect(result).toMatch(/^Patched a\.ts/);
    expect(result).toMatch(/removed read_file line numbers from oldText and newText/);
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('ONE\n\nTWO\nthree\n');
  });

  it('strips numbers from oldText only when newText carries none', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-edit-'));
    await writeFile(path.join(root, 'a.ts'), 'alpha\nbeta\n', 'utf8');
    const result = await editFile?.execute(
      { path: 'a.ts', oldText: '  12\talpha\n  13\tbeta', newText: 'gamma' },
      ctx(root),
    );
    expect(result).toMatch(/removed read_file line numbers from oldText$/m);
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('gamma\n');
  });

  it('does not strip when only some lines carry a number', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-edit-'));
    await writeFile(path.join(root, 'a.ts'), 'alpha\nbeta\n', 'utf8');
    const result = await editFile?.execute(
      { path: 'a.ts', oldText: '1\talpha\nbeta', newText: 'x' },
      ctx(root),
    );
    expect(result).toMatch(/not found/);
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('alpha\nbeta\n');
    expect(stripReadNumbers('1\talpha\nbeta')).toBeNull();
    expect(stripReadNumbers('1\talpha\n\n2\tbeta')).toBe('alpha\n\nbeta');
  });

  it('matches a file whose own lines look numbered as written', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-edit-'));
    await writeFile(path.join(root, 'data.tsv'), '1\tfoo\n2\tbar\n', 'utf8');
    const result = await editFile?.execute(
      { path: 'data.tsv', oldText: '1\tfoo', newText: '1\tFOO' },
      ctx(root),
    );
    expect(result).not.toMatch(/removed read_file line numbers/);
    expect(await readFile(path.join(root, 'data.tsv'), 'utf8')).toBe('1\tFOO\n2\tbar\n');
  });
});

describe('grep context', () => {
  const grep = WORKSPACE_TOOLS.find((tool) => tool.definition.function.name === 'grep');

  async function workspace(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agent-grep-'));
    await writeFile(
      path.join(root, 'a.ts'),
      ['one', 'two', 'hit A', 'four', 'hit B', 'six', 'seven', 'eight', 'nine', 'hit C', 'eleven'].join('\n'),
      'utf8',
    );
    return root;
  }

  it('prints matches only by default (unchanged format)', async () => {
    const root = await workspace();
    expect(await grep?.execute({ pattern: 'hit' }, ctx(root))).toBe(
      ['a.ts:3:hit A', 'a.ts:5:hit B', 'a.ts:10:hit C'].join('\n'),
    );
  });

  it('adds surrounding lines once, merges overlaps, and splits gaps with --', async () => {
    const root = await workspace();
    expect(await grep?.execute({ pattern: 'hit', context: 1 }, ctx(root))).toBe(
      [
        'a.ts-2-two',
        'a.ts:3:hit A',
        'a.ts-4-four',
        'a.ts:5:hit B',
        'a.ts-6-six',
        '--',
        'a.ts-9-nine',
        'a.ts:10:hit C',
        'a.ts-11-eleven',
      ].join('\n'),
    );
  });

  it('clamps context to the maximum', async () => {
    const root = await workspace();
    const out = String(await grep?.execute({ pattern: 'hit C', context: 99 }, ctx(root)));
    // Match on line 10, context capped at 5: lines 5–11 (the file ends at 11),
    // then one line that says the window was narrowed.
    const rows = out.split('\n');
    expect(rows).toHaveLength(8);
    expect(rows.at(-1)).toMatch(/^\(context capped at 5 lines; use read_file with offset/);
  });

  it('says nothing about the cap when the asked context fits', async () => {
    const root = await workspace();
    const out = String(await grep?.execute({ pattern: 'hit C', context: 2 }, ctx(root)));
    expect(out).not.toMatch(/context capped/);
  });
});

describe('glob syntax', () => {
  it('matches brace alternatives and character classes', () => {
    expect(globMatch('src/a/Button.tsx', '**/*.{ts,tsx,js}')).toBe(true);
    expect(globMatch('src/a/Button.css', '**/*.{ts,tsx,js}')).toBe(false);
    expect(globMatch('src/Components/DashBoard/DashBoard.tsx', 'src/**/*[Dd]ash[Bb]oard*')).toBe(true);
    expect(globMatch('src/x/index.ts', 'src/**/[!_]*.ts')).toBe(true);
    expect(globMatch('src/x/_private.ts', 'src/**/[!_]*.ts')).toBe(false);
    expect(globMatch('a/b.test.ts', '**/*.{spec,test}.{ts,tsx}')).toBe(true);
  });

  it('nests braces and keeps a lone brace literal', () => {
    expect(globMatch('src/app/page.tsx', 'src/{app,{lib,pages}}/*.tsx')).toBe(true);
    expect(globMatch('src/pages/x.tsx', 'src/{app,{lib,pages}}/*.tsx')).toBe(true);
    expect(globMatch('src/{x.ts', 'src/{x.ts')).toBe(true);
    expect(globMatch('a.b', 'a?b')).toBe(true);
    expect(globMatch('a/b', 'a?b')).toBe(false);
  });
});

describe('run_terminal shell note', () => {
  it('names cmd.exe on Windows and sh elsewhere', () => {
    expect(terminalShellNote('win32')).toMatch(/cmd\.exe/);
    expect(terminalShellNote('linux')).toMatch(/\/bin\/sh/);
  });
});

describe('read_file unit', () => {
  const lines = (n: number, width = 10) =>
    Array.from({ length: n }, (_, i) => `l${i + 1}`.padEnd(width, '.')).join('\n') + '\n';

  it('returns a file that fits the window whole, whatever offset/limit ask', () => {
    const out = formatFileRead(lines(300), 120, 10);
    expect(out.split('\n')[0]).toBe('[lines 1–300 of 300]');
    expect(out).not.toMatch(/continue with offset/);
  });

  it('windows a file larger than the window from the offset, at least the minimum lines', () => {
    // Wider than the char window: 4,000 lines × 21 chars.
    const big = lines(4_000, 20);
    expect(big.length).toBeGreaterThan(WORKSPACE_READ_MAX_CHARS);
    const out = formatFileRead(big, 1_000, 5);
    const header = out.split('\n')[0];
    expect(header).toBe(`[lines 1000–${1_000 + WORKSPACE_READ_MIN_LINES - 1} of 4000]`);
    expect(out).toMatch(/continue with offset=1200/);
  });

  it('cuts a large file at the char window and names where to continue', () => {
    const big = lines(4_000, 20);
    const out = formatFileRead(big, undefined, undefined);
    expect(out.length).toBeLessThanOrEqual(WORKSPACE_READ_MAX_CHARS + 200);
    expect(out).toMatch(/read_file truncated at line \d+ of 4000 — continue with offset=\d+/);
  });

  it('numbers each line with its absolute line number and a tab', () => {
    const out = formatFileRead('alpha\n\nbeta\n', undefined, undefined);
    expect(out).toBe('[lines 1–3 of 3]\n1\talpha\n2\t\n3\tbeta');
    const windowed = formatFileRead(lines(4_000, 20), 1_000, 5).split('\n');
    expect(windowed[1]).toBe(`1000\t${'l1000'.padEnd(20, '.')}`);
    expect(windowed[WORKSPACE_READ_MIN_LINES]).toMatch(/^1199\tl1199/);
  });

  it('bounds the numbered body by the char window, so the live cap never cuts it', () => {
    // Fits the window raw, but not with numbers: windowed, not returned whole.
    const raw = lines(1_900, 20);
    expect(raw.length).toBeLessThanOrEqual(WORKSPACE_READ_MAX_CHARS);
    const out = formatFileRead(raw, undefined, undefined);
    const [header, ...rest] = out.split('\n\n')[0]!.split('\n');
    const body = rest.join('\n');
    expect(body.length).toBeLessThanOrEqual(WORKSPACE_READ_MAX_CHARS);
    const last = Number(/^\[lines 1–(\d+) of 1900\]$/.exec(header ?? '')?.[1]);
    expect(last).toBeLessThan(1_900);
    expect(out).toMatch(new RegExp(`continue with offset=${last + 1}`));
    expect(out.length).toBeLessThanOrEqual(liveResultCapChars('read_file', 0));
  });
});

describe('run_terminal output and time', () => {
  it('passes short output through whole', () => {
    const capture = createOutputCapture(100, 20);
    capture.append('hello ');
    capture.append('world');
    expect(capture.text()).toBe('hello world');
  });

  it('keeps the start and the end of long output, in chunks, within the bound', () => {
    const capture = createOutputCapture(100, 20);
    for (let i = 0; i < 50; i++) capture.append(`line ${i} `);
    capture.append('FINAL ERROR');
    const text = capture.text();
    expect(text.startsWith('line 0 line 1 line 2')).toBe(true);
    expect(text.endsWith('FINAL ERROR')).toBe(true);
    expect(text).toMatch(/… \(\d+ characters of output cut here; the start and the end are kept\) …/);
    // Head + tail stay within the bound; only the marker is added.
    const marker = text.match(/\n… .* …\n/)?.[0] ?? '';
    expect(text.length - marker.length).toBeLessThanOrEqual(100);
  });

  it('defaults the timeout, honours timeoutSec within bounds', () => {
    expect(terminalTimeoutMs(undefined)).toBe(300_000);
    expect(terminalTimeoutMs(900)).toBe(900_000);
    expect(terminalTimeoutMs(999_999)).toBe(1_800_000);
    expect(terminalTimeoutMs(0)).toBe(300_000);
    expect(terminalTimeoutMs('600')).toBe(300_000);
  });

  it('a real command whose error comes last still shows it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'term-'));
    const terminal = WORKSPACE_TOOLS.find((tool) => tool.definition.function.name === 'run_terminal');
    const out = String(
      await terminal?.execute(
        { command: `node -e "console.log('a'.repeat(20000)); console.log('FINAL ERROR LINE')"` },
        ctx(root),
      ),
    );
    expect(out.split('\n')[1]).toBe('exit 0');
    expect(out).toContain('FINAL ERROR LINE');
    expect(out).toMatch(/characters of output cut here/);
  });
});

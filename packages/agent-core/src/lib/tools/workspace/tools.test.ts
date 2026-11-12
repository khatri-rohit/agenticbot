import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  formatFileRead,
  WORKSPACE_READ_MAX_CHARS,
  WORKSPACE_READ_MIN_LINES,
  WORKSPACE_TOOLS,
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
    // Match on line 10, context capped at 5: lines 5–11 (the file ends at 11).
    expect(out.split('\n')).toHaveLength(7);
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
});

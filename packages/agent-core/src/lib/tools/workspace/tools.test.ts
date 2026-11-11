import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { WORKSPACE_TOOLS } from './tools';

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

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { WORKSPACE_TOOLS } from './workspace';

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
    const root = await mkdtemp(path.join(os.tmpdir(), 'desk-edit-'));
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
    const root = await mkdtemp(path.join(os.tmpdir(), 'desk-edit-'));
    await writeFile(path.join(root, 'a.ts'), 'hello\n', 'utf8');
    const result = await editFile?.execute(
      { path: 'a.ts', oldText: 'missing', newText: 'nope' },
      ctx(root),
    );
    expect(result).toMatch(/not found/);
  });
});

import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@org/agent-models';

import {
  WORKSPACE_GREP_LINE_MAX_CHARS,
  WORKSPACE_READ_MAX_CHARS,
  WORKSPACE_TERMINAL_MAX_CHARS,
  editFileTool,
  globTool,
  grepTool,
  readFileTool,
  runTerminalTool,
  runWorkspaceCommand,
} from './workspace';
import { isPathInside, resolveWorkspacePath } from './workspace-path';

function ctx(root: string): ToolContext {
  return {
    runId: 'run',
    threadId: 'thread',
    origin: 'eval',
    workspaceRoot: root,
    signal: new AbortController().signal,
  };
}

async function fixture(): Promise<{ root: string; outside: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'agenticbot-ws-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'agenticbot-out-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'main.ts'), 'export const n = 1;\n', 'utf8');
  await writeFile(path.join(root, 'readme.md'), 'hello workspace\n', 'utf8');
  await writeFile(path.join(outside, 'secret.txt'), 'nope\n', 'utf8');
  return { root, outside };
}

describe('workspace path jail', () => {
  it('allows relative paths inside the root and rejects parent escapes', async () => {
    const { root, outside } = await fixture();
    const ok = await resolveWorkspacePath(root, 'src/main.ts');
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.abs).toBe(path.resolve(root, 'src/main.ts'));

    const escaped = await resolveWorkspacePath(root, '../secret.txt');
    expect(escaped.ok).toBe(false);

    const absOutside = await resolveWorkspacePath(root, path.join(outside, 'secret.txt'));
    expect(absOutside.ok).toBe(false);

    expect(isPathInside(root, path.join(root, 'src'))).toBe(true);
    expect(isPathInside(root, outside)).toBe(false);
  });

  it('rejects create paths whose parent symlink leaves the root', async () => {
    const { root, outside } = await fixture();
    const link = path.join(root, 'link');
    try {
      await symlink(
        outside,
        link,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      // Symlinks require privileges on some Windows setups.
      return;
    }
    const escaped = await resolveWorkspacePath(root, 'link/planted.txt');
    expect(escaped.ok).toBe(false);
  });
});

describe('workspace tools', () => {
  it('glob and grep stay inside the folder', async () => {
    const { root } = await fixture();
    await writeFile(path.join(root, '.gitignore'), 'dist\n', 'utf8');
    const listed = await globTool.execute({ pattern: '**/*.ts' }, ctx(root));
    expect(listed).toContain('src/main.ts');
    expect(listed).not.toContain('secret.txt');
    const dots = await globTool.execute({ pattern: '.gitignore' }, ctx(root));
    expect(dots).toContain('.gitignore');

    const hits = await grepTool.execute({ pattern: 'export const n' }, ctx(root));
    expect(hits).toContain('src/main.ts:1:');
  });

  it('grep clips long lines, skips binary, and caps total payload', async () => {
    const { root } = await fixture();
    const long = `needle ${'z'.repeat(WORKSPACE_GREP_LINE_MAX_CHARS + 80)}`;
    await writeFile(path.join(root, 'wide.txt'), `${long}\n`, 'utf8');
    await writeFile(path.join(root, 'bin.dat'), `needle\0more`, 'utf8');
    const hits = await grepTool.execute({ pattern: 'needle' }, ctx(root));
    expect(hits).toContain('wide.txt:1:');
    expect(hits).toMatch(/…/);
    expect(hits).not.toContain('bin.dat');
    const clippedLine = hits.split('\n')[0]?.split(':').slice(2).join(':') ?? '';
    expect(clippedLine.length).toBeLessThanOrEqual(WORKSPACE_GREP_LINE_MAX_CHARS + 1);
  });

  it('read_file caps output and rejects paths outside the root', async () => {
    const { root, outside } = await fixture();
    const denied = await readFileTool.execute(
      { path: path.join(outside, 'secret.txt') },
      ctx(root),
    );
    expect(denied).toMatch(/outside the workspace/i);

    const huge = 'x'.repeat(WORKSPACE_READ_MAX_CHARS + 50);
    await writeFile(path.join(root, 'big.txt'), huge, 'utf8');
    const body = await readFileTool.execute({ path: 'big.txt' }, ctx(root));
    expect(body.length).toBeLessThan(huge.length);
    expect(body).toMatch(/truncated/);
  });

  it('edit_file requires a unique span and can create a new file', async () => {
    const { root } = await fixture();
    const created = await editFileTool.execute(
      { path: 'src/new.ts', newText: 'export const created = true;\n' },
      ctx(root),
    );
    expect(created).toMatch(/^Created /);
    expect(await readFile(path.join(root, 'src/new.ts'), 'utf8')).toContain(
      'created = true',
    );

    const dup = await writeFile(
      path.join(root, 'src/dup.ts'),
      'alpha\nalpha\n',
      'utf8',
    ).then(() =>
      editFileTool.execute(
        { path: 'src/dup.ts', oldText: 'alpha', newText: 'beta' },
        ctx(root),
      ),
    );
    expect(dup).toMatch(/not unique/);

    const patched = await editFileTool.execute(
      { path: 'src/main.ts', oldText: 'export const n = 1;', newText: 'export const n = 2;' },
      ctx(root),
    );
    expect(patched).toMatch(/^Updated /);
    expect(await readFile(path.join(root, 'src/main.ts'), 'utf8')).toContain(
      'export const n = 2;',
    );
  });

  it('run_terminal uses the workspace cwd and caps output', async () => {
    const { root } = await fixture();
    const cwdOut = await runTerminalTool.execute(
      { command: 'node -e "process.stdout.write(process.cwd())"' },
      ctx(root),
    );
    expect(cwdOut).toContain(root);

    const cap = await runTerminalTool.execute(
      {
        command: `node -e "process.stdout.write('y'.repeat(${WORKSPACE_TERMINAL_MAX_CHARS + 80}))"`,
      },
      ctx(root),
    );
    expect(cap).toMatch(/truncated/);
    expect(cap.length).toBeLessThan(WORKSPACE_TERMINAL_MAX_CHARS + 200);
  });

  it('run_terminal times out and kills the child instead of hanging', async () => {
    const { root } = await fixture();
    const started = Date.now();
    const out = await runWorkspaceCommand(
      'node -e "setTimeout(() => {}, 20000)"',
      root,
      new AbortController().signal,
      1_000,
      400,
    );
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(out).toMatch(/killed after 400ms/);
  });
});

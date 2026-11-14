import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { readRecordedResult } from '../state/task-state';
import { quotedText, record_finding } from './record-finding';

function ctx(workspaceRoot?: string) {
  return {
    runId: 'r1',
    threadId: 't1',
    origin: 'eval' as const,
    signal: new AbortController().signal,
    ...(workspaceRoot ? { workspaceRoot } : {}),
  };
}

const record = (args: Record<string, unknown>, root?: string) => record_finding.execute(args, ctx(root));

describe('record_finding checks evidence and always records', () => {
  let root = '';
  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'agent-finding-'));
    await mkdir(path.join(root, 'src'), { recursive: true });
    // Line n reads `line n`, except a few known strings.
    const lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`);
    lines[515] = 'const MAX_TILES = 20; // "Maximum tile limit"';
    lines[99] = '<p>Hello <b>world</b></p>';
    await writeFile(path.join(root, 'src/a.ts'), `${lines.join('\r\n')}\r\n`, 'utf8');
  });

  it('verifies quoted text at the cited lines (±3)', async () => {
    const result = await record({ claim: 'The cap is `MAX_TILES = 20`', evidence: 'src/a.ts:513-514' }, root);
    expect(result).toBe('Recorded (verified) — evidence: src/a.ts:513-514');
    expect(readRecordedResult(result)).toEqual({ verification: 'verified', evidence: 'src/a.ts:513-514' });
  });

  it('corrects the line when the quote is elsewhere in the cited file', async () => {
    const result = await record(
      { claim: 'The tile cap is "Maximum tile limit"', evidence: 'src/a.ts:490–498' },
      root,
    );
    expect(result.split('\n')[0]).toBe(
      'Recorded (evidence corrected: "Maximum tile limit" is at src/a.ts:516, not 490-498) — evidence: src/a.ts:516',
    );
    expect(readRecordedResult(result)).toEqual({ verification: 'corrected', evidence: 'src/a.ts:516' });
  });

  it('records as unverified when the quote is not in the cited file', async () => {
    const result = await record({ claim: 'It says "Hello world"', evidence: 'src/a.ts:100' }, root);
    expect(result).toMatch(/^Recorded \(unverified: "Hello world" not found in src\/a\.ts\) — evidence: src\/a\.ts:100\n/);
    expect(readRecordedResult(result).verification).toBe('unverified');
  });

  it('records as unverified when the file is missing or the line is past its end', async () => {
    const missing = await record({ claim: 'It exists', evidence: 'src/missing.ts:3' }, root);
    expect(missing).toMatch(/^Recorded \(unverified: src\/missing\.ts not found\) — evidence: src\/missing\.ts:3/);
    const past = await record({ claim: 'Something at the end', evidence: 'src/a.ts:900' }, root);
    expect(past).toMatch(/^Recorded \(unverified: line 900 is past the end of src\/a\.ts \(600 lines\)\)/);
  });

  it('verifies a claim without quotes when the file and lines exist', async () => {
    const result = await record({ claim: 'The cap lives in a.ts', evidence: 'src/a.ts:516; src/a.ts:1, 3' }, root);
    expect(result).toBe('Recorded (verified) — evidence: src/a.ts:516; src/a.ts:1, 3');
  });

  it('skips URLs and runs without a workspace', async () => {
    const url = await record({ claim: 'Docs say "use X"', evidence: 'https://example.com/docs' }, root);
    expect(url).toBe('Recorded (verification skipped) — evidence: https://example.com/docs');
    const none = await record({ claim: 'The cap is "Maximum tile limit"', evidence: 'src/a.ts:1' });
    expect(readRecordedResult(none)).toEqual({ verification: 'skipped', evidence: 'src/a.ts:1' });
  });

  it('only refuses a call that lacks claim or evidence', async () => {
    expect(await record({ claim: 'x', evidence: '' }, root)).toMatch(/^Error:/);
  });

  it('finds quotes in a claim, not apostrophes inside words', () => {
    expect(quotedText(`it's the "Max tiles" and 'tile cap' with \`id\``)).toEqual(['Max tiles', 'tile cap']);
  });
});

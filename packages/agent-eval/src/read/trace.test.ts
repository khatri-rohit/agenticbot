import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { linesOf, parseTrace, readRunTrace } from './trace.js';

const jsonl = (lines: unknown[]) => lines.map((line) => JSON.stringify(line)).join('\n');

describe('parseTrace', () => {
  it('orders by seq and keeps the sink stamps', () => {
    const { lines, warnings } = parseTrace(
      jsonl([
        { v: 2, ts: '2026-10-31T00:00:01.000Z', seq: 2, type: 'llm_request', runId: 'r', iteration: 1 },
        { v: 2, ts: '2026-10-31T00:00:00.000Z', seq: 1, type: 'run_start', runId: 'r', model: 'm' },
      ]),
    );
    expect(warnings).toBe(0);
    expect(lines.map((line) => line.type)).toEqual(['run_start', 'llm_request']);
    expect(lines[0]?.ts).toBe('2026-10-31T00:00:00.000Z');
    expect(linesOf(lines, 'run_start')[0]?.model).toBe('m');
  });

  it('keeps file order when any line lacks seq (older traces)', () => {
    const { lines } = parseTrace(
      jsonl([
        { type: 'llm_request', runId: 'r', iteration: 1 },
        { seq: 1, type: 'run_start', runId: 'r', model: 'm' },
      ]),
    );
    expect(lines.map((line) => line.type)).toEqual(['llm_request', 'run_start']);
  });

  it('skips corrupt lines and counts them', () => {
    const text = [
      JSON.stringify({ seq: 1, type: 'run_start', runId: 'r', model: 'm' }),
      'not json',
      JSON.stringify({ seq: 2, noType: true }),
      '{ broken',
      '',
    ].join('\n');
    const { lines, warnings } = parseTrace(text);
    expect(lines).toHaveLength(1);
    expect(warnings).toBe(3);
  });

  it('keeps event types it does not know (newer traces)', () => {
    const { lines } = parseTrace(jsonl([{ seq: 1, type: 'future_event', runId: 'r' }]));
    expect(lines[0]?.type).toBe('future_event');
  });
});

describe('readRunTrace', () => {
  it('treats a missing file as an empty trace', async () => {
    const result = await readRunTrace(path.join(os.tmpdir(), 'agent-eval-missing.jsonl'));
    expect(result).toEqual({ lines: [], warnings: 0 });
  });

  it('reads a file from disk', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agent-eval-trace-'));
    const file = path.join(dir, 'r.jsonl');
    await writeFile(file, `${jsonl([{ seq: 1, type: 'run_start', runId: 'r', model: 'm' }])}\n`);
    const result = await readRunTrace(file);
    expect(result.lines).toHaveLength(1);
  });
});

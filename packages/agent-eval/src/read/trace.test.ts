import { describe, it, expect } from 'vitest';
import { readRunTrace } from './trace.js';
import { writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('readRunTrace', () => {
  const tmp = path.join(os.tmpdir(), `eval-trace-test-${Date.now()}`);

  it('parses valid JSONL with seq and sorts by seq', async () => {
    await mkdir(tmp, { recursive: true });
    const file = path.join(tmp, 'run.jsonl');
    const lines = [
      JSON.stringify({ v: 1, ts: '2026-01-01T00:00:01Z', seq: 2, type: 'tool_call', name: 'read_file' }),
      JSON.stringify({ v: 1, ts: '2026-01-01T00:00:00Z', seq: 1, type: 'run_start', model: 'test' }),
      JSON.stringify({ v: 1, ts: '2026-01-01T00:00:02Z', seq: 3, type: 'run_settled', finishReason: 'stop' }),
    ];
    await writeFile(file, lines.join('\n') + '\n');

    const result = await readRunTrace(file);
    expect(result.warnings).toBe(0);
    expect(result.events).toHaveLength(3);
    // Sorted by seq: run_start (1), tool_call (2), run_settled (3)
    expect(result.events[0].type).toBe('run_start');
    expect(result.events[1].type).toBe('tool_call');
    expect(result.events[2].type).toBe('run_settled');
  });

  it('skips corrupt lines and counts them as warnings', async () => {
    await mkdir(tmp, { recursive: true });
    const file = path.join(tmp, 'corrupt.jsonl');
    const lines = [
      JSON.stringify({ v: 1, seq: 1, type: 'run_start', model: 'test' }),
      'this is not json',
      JSON.stringify({ v: 1, seq: 2, type: 'run_settled' }),
      '{ broken json',
    ];
    await writeFile(file, lines.join('\n') + '\n');

    const result = await readRunTrace(file);
    expect(result.warnings).toBe(2);
    expect(result.events).toHaveLength(2);
  });

  it('returns empty events for missing file', async () => {
    const result = await readRunTrace(path.join(tmp, 'nonexistent.jsonl'));
    expect(result.events).toHaveLength(0);
    expect(result.warnings).toBe(0);
  });

  it('keeps file order when seq is missing', async () => {
    await mkdir(tmp, { recursive: true });
    const file = path.join(tmp, 'noseq.jsonl');
    const lines = [
      JSON.stringify({ type: 'run_start', model: 'test' }),
      JSON.stringify({ type: 'tool_call', name: 'grep' }),
    ];
    await writeFile(file, lines.join('\n') + '\n');

    const result = await readRunTrace(file);
    expect(result.events).toHaveLength(2);
    expect(result.events[0].type).toBe('run_start');
    expect(result.events[1].type).toBe('tool_call');
  });

  it('cleans up', async () => {
    await rm(tmp, { recursive: true, force: true });
  });
});
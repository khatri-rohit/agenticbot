import {
  lastRunFrom,
  RUN_CANCELLED_REASON,
  RUN_INTERRUPTED_REASON,
  type ThreadLastRun,
} from '@agent/agent-models';
import { describe, expect, it } from 'vitest';

import { stopLabel, summarizeRun } from './runs.js';
import { parseTrace, type TraceLine } from './trace.js';

const start: TraceLine = { seq: 1, ts: '2026-11-04T10:00:00.000Z', type: 'run_start', runId: 'r1', model: 'm' };
const finish = (status: string, limitReason?: string): TraceLine => ({
  seq: 9,
  ts: '2026-11-04T10:01:00.000Z',
  type: 'run_finish',
  runId: 'r1',
  iterations: 3,
  toolCalls: 2,
  status,
  ...(limitReason ? { limitReason } : {}),
});

function summary(lines: TraceLine[], lastRun: ThreadLastRun | null) {
  return summarizeRun({ runId: 'r1', threadId: 't1', tracePath: 'r1.jsonl', lines, warnings: 0, lastRun });
}

const lastRun = (outcome: Parameters<typeof lastRunFrom>[0]['outcome'], runId = 'r1', limitReason?: string) =>
  lastRunFrom({ runId, outcome, iterations: 3, toolCalls: 2, ...(limitReason ? { limitReason } : {}) });

describe('summarizeRun status', () => {
  it('takes run_finish when the run finished normally', () => {
    const run = summary([start, finish('incomplete', 'limit.tokens: over budget')], lastRun('incomplete', 'r1', 'limit.tokens: over budget'));
    expect(run.status).toBe('incomplete');
    expect(run.limitReason).toBe('limit.tokens: over budget');
  });

  it('marks a cancelled run cancelled, whatever run_finish said', () => {
    const run = summary([start, finish('completed')], lastRun('cancelled'));
    expect(run.status).toBe('cancelled');
    expect(run.limitReason).toBe(RUN_CANCELLED_REASON);
  });

  it('reads the cancel marker from the trace, on any run of a thread', () => {
    const cancelled = { ...finish('error'), cancelled: true } as TraceLine;
    const run = summary([start, cancelled], lastRun('completed', 'a-later-run'));
    expect(run.status).toBe('cancelled');
    expect(run.limitReason).toBe(RUN_CANCELLED_REASON);
  });

  it('marks a run with no run_finish and the start marker interrupted', () => {
    const run = summary([start], lastRun('interrupted'));
    expect(run.status).toBe('interrupted');
    expect(run.limitReason).toBe(RUN_INTERRUPTED_REASON);
    expect(run.finishedAt).toBeUndefined();
  });

  it('ignores a last-run that belongs to another run', () => {
    expect(summary([start], lastRun('cancelled', 'other')).status).toBe('unknown');
    expect(summary([start, finish('completed')], lastRun('cancelled', 'other')).status).toBe('completed');
  });

  it('reads a fixture trace end to end', () => {
    const text = [start, finish('error')].map((line) => JSON.stringify(line)).join('\n');
    expect(summary(parseTrace(text).lines, null).status).toBe('error');
  });
});

describe('stopLabel', () => {
  it('labels limit codes, cancels, crashes and anything else', () => {
    expect(stopLabel('limit.capacity: weekly allowance spent')).toBe('limit.capacity');
    expect(stopLabel(RUN_CANCELLED_REASON)).toBe('cancelled');
    expect(stopLabel(RUN_INTERRUPTED_REASON)).toBe('interrupted');
    expect(stopLabel('eval.timeout: trial passed its hard deadline')).toBe('other');
    expect(stopLabel(undefined)).toBe('');
  });
});

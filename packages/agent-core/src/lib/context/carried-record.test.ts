import { describe, expect, it } from 'vitest';

import type { LedgerEnvelope, RunTaskRecord, TaskFinding, TaskStateSnapshot } from '@agent/agent-models';

import { createToolRegistry } from '../tools/registry';
import { assembleContext } from './assemble-context';
import {
  ledgerRunIds,
  mergeCarriedRecords,
  prepareCarriedRecord,
  renderCarriedRecord,
  taskRecordFromRun,
} from './carried-record';

const finding = (claim: string, evidence = 'src/a.ts:1', extra: Partial<TaskFinding> = {}): TaskFinding => ({
  claim,
  evidence,
  iteration: 1,
  verification: 'verified',
  ...extra,
});

const record = (runId: string, findings: TaskFinding[], openQuestions: string[] = []): RunTaskRecord => ({
  runId,
  finishedAt: '2026-11-13T00:00:00.000Z',
  findings,
  openQuestions,
});

function envelope(seq: number, runId: string | null, role: 'user' | 'assistant', content: string): LedgerEnvelope {
  return { v: 1, seq, ts: '2026-11-13T00:00:00.000Z', threadId: 't1', runId, record: { role, content } };
}

describe('carried task record', () => {
  it('takes a finished run\'s findings and gaps, and nothing from a run that recorded none', () => {
    const task = {
      evidence: { findings: [finding('Port is 3000')] },
      childGaps: ['where is the proxy set?'],
    } as unknown as TaskStateSnapshot;
    expect(taskRecordFromRun('r1', task, 'now')).toEqual({
      runId: 'r1',
      finishedAt: 'now',
      findings: [finding('Port is 3000')],
      openQuestions: ['where is the proxy set?'],
    });
    const empty = { evidence: { findings: [] }, childGaps: [] } as unknown as TaskStateSnapshot;
    expect(taskRecordFromRun('r2', empty)).toBeNull();
    expect(taskRecordFromRun('r3', undefined)).toBeNull();
  });

  it('merges only runs still in the ledger, one finding per claim, the newest run winning', () => {
    const records = [
      record('r1', [finding('Port is 3000', 'src/a.ts:1'), finding('Uses vite')], ['q1']),
      record('r2', [finding('Port is 3000', 'src/a.ts:9')], ['q1', 'q2']),
      record('cut', [finding('Rewound claim')]),
    ];
    const live = ledgerRunIds([envelope(1, null, 'user', 'hi'), envelope(2, 'r1', 'assistant', 'a'), envelope(4, 'r2', 'assistant', 'b')]);
    const merged = mergeCarriedRecords(records, live);
    expect(merged.findings.map((f) => `${f.claim}@${f.evidence}`)).toEqual(['Uses vite@src/a.ts:1', 'Port is 3000@src/a.ts:9']);
    expect(merged.openQuestions).toEqual(['q1', 'q2']);
  });

  it('renders within the bound and points at the full record when it does not fit', async () => {
    const many = Array.from({ length: 200 }, (_, i) => finding(`fact number ${i} about the dashboard layout`, `src/b.ts:${i + 1}`, { topic: 'layout' }));
    const stored: string[] = [];
    const text = await prepareCarriedRecord({
      records: [record('r1', many)],
      envelopes: [envelope(2, 'r1', 'assistant', 'done')],
      tokens: 1_000,
      putBlob: async (body) => {
        stored.push(body);
        return 'f'.repeat(64);
      },
    });
    expect(text).toContain('# Task record (earlier runs)');
    expect(text).toContain(`recall sha256:${'f'.repeat(64)}`);
    expect(text).toContain('fact number 199');
    expect(text!.length).toBeLessThan(1_000 * 4 + 200);
    expect(stored[0]).toContain('fact number 0 ');
  });

  it('is null when there is nothing to carry', () => {
    expect(renderCarriedRecord({ findings: [], openQuestions: [] }, 1_000)).toBeNull();
  });

  it('sits in the stable prefix after the conversation summary, with its own layer', () => {
    const carried = renderCarriedRecord({ findings: [finding('Port is 3000')], openQuestions: [] }, 1_000)!;
    const { messages, report } = assembleContext({
      tools: createToolRegistry([]),
      memory: { user: '', notes: '' },
      snapshot: {
        threadId: 't1',
        throughSeq: 0,
        model: 'test',
        brief: 'Goal: ship it',
        summary: 'Earlier talk.',
        createdAt: '2026-11-13T00:00:00.000Z',
      },
      envelopes: [envelope(1, null, 'user', 'next question')],
      carriedRecord: carried,
    });
    const system = String(messages[0]!.content);
    expect(system.indexOf('Earlier talk.')).toBeLessThan(system.indexOf('# Task record (earlier runs)'));
    expect(system).toContain('Port is 3000 — src/a.ts:1');
    expect(report.layers.find((layer) => layer.id === 'record')!.tokens).toBeGreaterThan(0);
  });
});

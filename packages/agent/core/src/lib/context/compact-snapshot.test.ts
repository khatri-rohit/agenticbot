import { describe, expect, it } from 'vitest';
import type { LedgerEnvelope } from '@org/agent-models';

import {
  buildExtractiveSnapshot,
  chooseCompactThroughSeq,
} from './compact-snapshot';
import { assembleContext } from './assemble-context';
import { createToolRegistry } from '../tools/registry';

function envelope(
  seq: number,
  role: 'user' | 'assistant',
  content: string,
): LedgerEnvelope {
  return {
    v: 1,
    seq,
    ts: '2026-01-01T00:00:00.000Z',
    threadId: 't1',
    runId: null,
    record: { role, content },
  };
}

describe('compact snapshot', () => {
  it('keeps the last N user turns live', () => {
    const envelopes = [
      envelope(1, 'user', 'one'),
      envelope(2, 'assistant', 'a1'),
      envelope(3, 'user', 'two'),
      envelope(4, 'assistant', 'a2'),
      envelope(5, 'user', 'three'),
    ];
    expect(chooseCompactThroughSeq(envelopes, 2)).toBe(2);
    expect(chooseCompactThroughSeq(envelopes, 5)).toBeNull();
  });

  it('builds a brief and summary from compacted user/assistant turns', () => {
    const envelopes = [
      envelope(1, 'user', 'fix the build'),
      envelope(2, 'assistant', 'I will look at tsconfig'),
      envelope(3, 'user', 'it still fails'),
    ];
    const snapshot = buildExtractiveSnapshot({
      threadId: 't1',
      model: 'test',
      envelopes,
      throughSeq: 2,
    });
    expect(snapshot.throughSeq).toBe(2);
    expect(snapshot.brief).toMatch(/fix the build/);
    expect(snapshot.summary).toMatch(/User: fix the build/);
    expect(snapshot.summary).toMatch(/Assistant: I will look/);
  });

  it('assembleContext drops ledger rows at or below throughSeq', () => {
    const tools = createToolRegistry([]);
    const envelopes = [
      envelope(1, 'user', 'old question'),
      envelope(2, 'assistant', 'old answer'),
      envelope(3, 'user', 'new question'),
    ];
    const { messages } = assembleContext({
      tools,
      memory: { user: '', notes: '' },
      snapshot: {
        threadId: 't1',
        throughSeq: 2,
        model: 'test',
        brief: 'Goal: old question',
        summary: 'User asked about the old thing.',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      envelopes,
    });
    const blob = JSON.stringify(messages);
    expect(blob).toContain('new question');
    expect(blob).not.toContain('old answer');
    expect(blob).toContain('Goal: old question');
  });
});

import { describe, expect, it } from 'vitest';
import type { LedgerEnvelope } from '@org/agent-models';

import {
  buildExtractiveSnapshot,
  chooseCompactThroughSeq,
} from './compact-snapshot';
import { assembleContext, stubLiveToolResults } from './assemble-context';
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

  it('records files and commands from assistant tool calls in the brief', () => {
    const envelopes: LedgerEnvelope[] = [
      envelope(1, 'user', 'fix the build'),
      {
        v: 1,
        seq: 2,
        ts: '2026-01-01T00:00:00.000Z',
        threadId: 't1',
        runId: null,
        record: {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'c1',
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: '{"path":"src/main.ts","oldText":"a","newText":"b"}',
              },
            },
            {
              id: 'c2',
              type: 'function',
              function: {
                name: 'run_terminal',
                arguments: '{"command":"npx tsc --noEmit"}',
              },
            },
          ],
        },
      },
    ];
    const snapshot = buildExtractiveSnapshot({
      threadId: 't1',
      model: 'test',
      envelopes,
      throughSeq: 2,
    });
    expect(snapshot.brief).toMatch(/src\/main\.ts/);
    expect(snapshot.brief).toMatch(/npx tsc --noEmit/);
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

  it('assembleContext injects mentioned threads as a system layer', () => {
    const tools = createToolRegistry([]);
    const { messages, report } = assembleContext({
      tools,
      memory: { user: '', notes: '' },
      snapshot: null,
      envelopes: [envelope(1, 'user', 'continue from that chat')],
      mentionedThreads: [
        {
          threadId: 'other',
          title: 'Fix login',
          sourceLabel: 'agenticbot',
          text: 'User asked to fix auth.',
        },
      ],
    });
    const blob = JSON.stringify(messages);
    expect(blob).toContain('Attached threads');
    expect(blob).toContain('Fix login');
    expect(blob).toContain('User asked to fix auth');
    const mentionLayer = report.layers.find((layer) => layer.id === 'mentions');
    expect(mentionLayer?.tokens).toBeGreaterThan(0);
  });

  it('assembleContext injects a non-empty thread plan as a system layer', () => {
    const tools = createToolRegistry([]);
    const { messages, report } = assembleContext({
      tools,
      memory: { user: '', notes: '' },
      snapshot: null,
      envelopes: [envelope(1, 'user', 'implement the plan')],
      plan: {
        threadId: 't1',
        goal: 'Add plan journal',
        notes: [],
        decisions: [{ id: 'd1', at: '2026-01-01T00:00:00.000Z', text: 'Thread-scoped' }],
        final: 'Write plan.json and inject it every run.',
        todos: [
          { id: 't1', content: 'Types', status: 'completed' },
          { id: 't2', content: 'UI card', status: 'in_progress' },
        ],
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    const blob = JSON.stringify(messages);
    expect(blob).toContain('Thread plan');
    expect(blob).toContain('Add plan journal');
    expect(blob).toContain('Write plan.json');
    expect(blob).toContain('UI card');
    expect(blob).not.toContain('Thread-scoped');
    const planLayer = report.layers.find((layer) => layer.id === 'plan');
    expect(planLayer?.tokens).toBeGreaterThan(0);
  });

  it('stubLiveToolResults caps oversized tool rows in the live prompt', () => {
    const huge = 'x'.repeat(20_000);
    const messages = [
      { role: 'system' as const, content: 'sys' },
      { role: 'user' as const, content: 'go' },
      {
        role: 'tool' as const,
        tool_call_id: 'c1',
        content: huge,
      },
    ];
    const stubbed = stubLiveToolResults(messages);
    expect(stubbed).toBe(1);
    const tool = messages[2];
    expect(tool?.role).toBe('tool');
    if (tool?.role === 'tool') {
      expect(tool.content).toMatch(/^\(stub\)/);
      expect(tool.content.length).toBeLessThan(huge.length);
    }
  });
});

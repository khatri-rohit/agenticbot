/**
 * What one run hands to the next (the carry-over). Earlier turns' tool
 * results are re-sent on every model call of the new run, so their size is
 * bounded in tokens, not by a share of the window or a count of turns.
 * Shapes are from live threads: a "continue" turn after a long run.
 */
import { describe, expect, it } from 'vitest';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import {
  CHARS_PER_TOKEN,
  contextBudgetForWindow,
  type LedgerEnvelope,
  type ThreadPlan,
} from '@agent/agent-models';

import { createToolRegistry } from '../tools/registry';
import { assembleContext, currentUserRequest } from './assemble-context';
import { planCompaction } from './compact-snapshot';

const WINDOWS = [260_000, 1_048_576];
const MEMORY = { user: '', notes: '' };

function row(seq: number, record: LedgerEnvelope['record']): LedgerEnvelope {
  return { v: 1, seq, ts: '2026-01-01T00:00:00.000Z', threadId: 't1', runId: null, record };
}

/** A long first run (`results` file reads of `chars` each), its handoff, then the user's "continue". */
function continuedThread(results: number, chars: number): LedgerEnvelope[] {
  const calls = Array.from({ length: results }, (_, i) => ({
    id: `c${i}`,
    type: 'function' as const,
    function: { name: 'read_file', arguments: JSON.stringify({ path: `src/f${i}.ts` }) },
  }));
  let seq = 0;
  return [
    row(++seq, { role: 'user', content: 'migrate the app to TypeScript' }),
    row(++seq, { role: 'assistant', content: '', tool_calls: calls }),
    ...calls.map((call, i) => row(++seq, { role: 'tool', tool_call_id: call.id, content: `${i}:${'x'.repeat(chars)}` })),
    row(++seq, { role: 'assistant', content: 'Handoff: phase 3 is half done; next step is src/app.' }),
    row(++seq, { role: 'user', content: 'continue' }),
  ];
}

function toolTokens(messages: ChatCompletionMessageParam[]): number {
  const chars = messages
    .filter((message) => message.role === 'tool')
    .reduce((sum, message) => sum + String(message.content ?? '').length, 0);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

describe('carry-over: earlier turns in a new run', () => {
  it.each(WINDOWS)('keeps earlier tool results under the carry-over cap on a %d-token window', (window) => {
    const budget = contextBudgetForWindow(window);
    // 30 reads of 15k chars (each under the per-result cap): 112k tokens from the run before.
    const { messages, report } = assembleContext(
      { tools: createToolRegistry([]), memory: MEMORY, snapshot: null, envelopes: continuedThread(30, 15_000) },
      budget,
    );

    // The cap, plus room for the short cards the removed results leave.
    expect(toolTokens(messages)).toBeLessThanOrEqual(budget.carryOverToolTokens + 5_000);
    expect(report.stubbedToolResults).toBeGreaterThan(0);

    const tools = messages.filter((message) => message.role === 'tool');
    // Newest stay in full, oldest leave: the end of the last run is what the next one needs.
    expect(String(tools.at(-1)!.content)).toHaveLength(15_000 + '29:'.length);
    expect(String(tools[0]!.content).length).toBeLessThan(1_000);
    // The conversation itself is untouched.
    const text = messages.map((message) => String(message.content ?? '')).join('\n');
    expect(text).toContain('migrate the app to TypeScript');
    expect(text).toContain('Handoff: phase 3 is half done');
  });

  it('carries the same amount whatever the window', () => {
    const [small, large] = WINDOWS.map((window) =>
      toolTokens(
        assembleContext(
          { tools: createToolRegistry([]), memory: MEMORY, snapshot: null, envelopes: continuedThread(30, 15_000) },
          contextBudgetForWindow(window),
        ).messages,
      ),
    );
    expect(large).toBe(small);
  });

  it('caps the results of an earlier run of the same turn too (a run resumed with no new message)', () => {
    // The thread as it stands when a run is resumed: no user message after the results.
    const envelopes = continuedThread(30, 15_000).slice(0, -1);
    const budget = contextBudgetForWindow(260_000);
    const { messages } = assembleContext(
      { tools: createToolRegistry([]), memory: MEMORY, snapshot: null, envelopes },
      budget,
    );
    expect(toolTokens(messages)).toBeLessThanOrEqual(budget.carryOverToolTokens + 5_000);
  });

  it('leaves a short history alone', () => {
    const { messages, report } = assembleContext(
      { tools: createToolRegistry([]), memory: MEMORY, snapshot: null, envelopes: continuedThread(3, 4_000) },
      contextBudgetForWindow(260_000),
    );
    expect(report.stubbedToolResults).toBe(0);
    expect(messages.filter((message) => message.role === 'tool').every((message) => String(message.content).length > 4_000)).toBe(true);
  });

  it.each(WINDOWS)('asks for compaction at the same conversation size on a %d-token window', (window) => {
    // 26 turns of long answers: about 130k tokens of conversation text.
    const envelopes: LedgerEnvelope[] = [];
    let seq = 0;
    for (let turn = 0; turn < 26; turn++) {
      envelopes.push(row(++seq, { role: 'user', content: `question ${turn}` }));
      envelopes.push(row(++seq, { role: 'assistant', content: `answer ${turn} ${'y'.repeat(20_000)}` }));
    }
    envelopes.push(row(++seq, { role: 'user', content: 'continue' }));
    const { report } = assembleContext(
      { tools: createToolRegistry([]), memory: MEMORY, snapshot: null, envelopes },
      contextBudgetForWindow(window),
    );
    expect(report.occupiedTokens).toBeGreaterThan(100_000);
    expect(report.needsCompaction).toBe(true);
    expect(planCompaction(envelopes, report)).not.toBeNull();
  });
});

describe('the user request of the current turn', () => {
  const plan: ThreadPlan = {
    threadId: 't1',
    goal: 'Migrate to Next 15',
    notes: [],
    decisions: [],
    final: 'Phase 1: bump dependencies. Phase 2: move to src/.',
    todos: [{ id: 'p1', content: 'Phase 1', status: 'pending' }],
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('is the user’s own words, without the harness context put in front of them', () => {
    const { messages } = assembleContext({
      tools: createToolRegistry([]),
      memory: MEMORY,
      snapshot: null,
      envelopes: [
        row(1, { role: 'user', content: 'plan the migration' }),
        row(2, { role: 'assistant', content: 'Planned.' }),
        row(3, { role: 'user', content: 'continue with phase 2' }),
      ],
      plan,
    });
    const last = messages.filter((message) => message.role === 'user').at(-1)!;
    // The plan rides in front of the user's message; that is what the brief used to copy.
    expect(String(last.content)).toContain('Phase 1: bump dependencies');
    expect(currentUserRequest(messages)).toBe('continue with phase 2');
  });

  it('is the message as sent when the harness added nothing', () => {
    expect(currentUserRequest([{ role: 'user', content: 'fix the build' }])).toBe('fix the build');
    expect(currentUserRequest([{ role: 'system', content: 'rules' }])).toBeUndefined();
  });
});

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONTEXT_BUDGET, type ContextBudget } from '@agent/agent-models';

import { manageWorkingSet, type WorkingSetView } from './residency';

type Call = { id: string; name: string; args: Record<string, unknown>; result: string; iteration: number };

const body = (label: string, chars = 4_000) => `${label}\n${'x'.repeat(chars)}`;
const read = (from: number, to: number, of: number, chars = 4_000) =>
  `[lines ${from}–${to} of ${of}]\n${'r'.repeat(chars)}`;

/** One assistant row per call, then its tool row (one call per iteration). */
function transcript(calls: Call[]): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: 'go' }];
  for (const call of calls) {
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } },
      ],
    });
    messages.push({ role: 'tool', tool_call_id: call.id, content: call.result });
  }
  return messages;
}

function view(calls: Call[], iteration: number, unchecked: string[] = []): WorkingSetView {
  const touches = new Map<string, number>();
  for (const call of calls) {
    const path = typeof call.args.path === 'string' ? call.args.path : null;
    if (path) touches.set(path, Math.max(touches.get(path) ?? 0, call.iteration));
  }
  return {
    iteration,
    callIteration: (id) => calls.find((call) => call.id === id)?.iteration,
    lastTouch: (path) => touches.get(path),
    isUnchecked: (path) => unchecked.includes(path),
  };
}

const budget = (over: Partial<ContextBudget> = {}): ContextBudget => ({
  ...DEFAULT_CONTEXT_BUDGET,
  inRunClearAtLeastTokens: 500,
  inRunResidentToolTokens: 100_000,
  inRunColdAfterIterations: 4,
  inRunKeepToolResults: 1,
  ...over,
});

const pathOf = (args: Record<string, unknown>) => (typeof args.path === 'string' ? args.path : null);
const blob = async (text: string) => `sha-${text.length}`;
const contentOf = (messages: ChatCompletionMessageParam[], id: string) =>
  messages.find((message) => message.role === 'tool' && message.tool_call_id === id)?.content as string;

describe('manageWorkingSet', () => {
  it('cards an older read that a later read covers, with a read-again hint', async () => {
    const calls: Call[] = [
      { id: 'a', name: 'read_file', args: { path: 'a.ts' }, result: read(1, 100, 100), iteration: 1 },
      { id: 'b', name: 'read_file', args: { path: 'a.ts' }, result: read(1, 100, 100, 4_100), iteration: 2 },
    ];
    const messages = transcript(calls);
    const result = await manageWorkingSet(messages, 1, budget(), [], blob, pathOf, view(calls, 2));
    expect(result?.byReason).toEqual({ superseded: ['a'] });
    expect(contentOf(messages, 'a')).toMatch(/^\(evicted\) read_file .*superseded by a later read of the same lines.*read_file again for the current contents/);
    expect(contentOf(messages, 'b')).toMatch(/^\[lines 1–100 of 100\]/);
  });

  it('cards a file nobody touched for the cold window, keeps one in use', async () => {
    const calls: Call[] = [
      { id: 'a', name: 'read_file', args: { path: 'a.ts' }, result: read(1, 50, 50), iteration: 1 },
      { id: 'b', name: 'read_file', args: { path: 'b.ts' }, result: read(1, 50, 50), iteration: 5 },
    ];
    const messages = transcript(calls);
    const result = await manageWorkingSet(messages, 1, budget(), [], blob, pathOf, view(calls, 6));
    expect(result?.byReason).toEqual({ cold: ['a'] });
    expect(contentOf(messages, 'a')).toMatch(/not used since iteration 1/);
  });

  it('never cards a file edited since the last check, however old', async () => {
    const calls: Call[] = [
      { id: 'a', name: 'read_file', args: { path: 'a.ts' }, result: read(1, 50, 50), iteration: 1 },
    ];
    const messages = transcript(calls);
    const result = await manageWorkingSet(messages, 1, budget(), [], blob, pathOf, view(calls, 20, ['a.ts']));
    expect(result).toBeNull();
  });

  it('waits until a cold/superseded pass frees enough (cache-friendly steps)', async () => {
    const calls: Call[] = [
      { id: 'a', name: 'read_file', args: { path: 'a.ts' }, result: read(1, 50, 50, 900), iteration: 1 },
    ];
    const messages = transcript(calls);
    const result = await manageWorkingSet(
      messages, 1, budget({ inRunClearAtLeastTokens: 10_000 }), [], blob, pathOf, view(calls, 9),
    );
    expect(result).toBeNull();
  });

  it('enforces the resident cap at once, least recently touched first, sparing this step', async () => {
    const calls: Call[] = [
      { id: 'a', name: 'read_file', args: { path: 'a.ts' }, result: read(1, 50, 50, 8_000), iteration: 1 },
      { id: 'b', name: 'read_file', args: { path: 'b.ts' }, result: read(1, 50, 50, 8_000), iteration: 2 },
      { id: 'c', name: 'read_file', args: { path: 'c.ts' }, result: read(1, 50, 50, 8_000), iteration: 3 },
    ];
    const messages = transcript(calls);
    // ~6k tokens resident against a 4.5k cap; nothing is cold yet.
    const result = await manageWorkingSet(
      messages, 1, budget({ inRunResidentToolTokens: 4_500, inRunClearAtLeastTokens: 100_000 }), [], blob, pathOf, view(calls, 3),
    );
    expect(result?.byReason).toEqual({ budget: ['a'] });
    expect(contentOf(messages, 'c')).toMatch(/^\[lines/);
  });

  it('a later refused command does not supersede a real run; a real re-run does', async () => {
    const ran = `cwd: /w\nexit 1\n${'e'.repeat(3_000)}`;
    const calls: Call[] = [
      { id: 'a', name: 'run_terminal', args: { command: 'npm test' }, result: ran, iteration: 1 },
      { id: 'b', name: 'run_terminal', args: { command: 'npm test' }, result: 'This exact tool call has already been attempted multiple times.', iteration: 2 },
    ];
    const messages = transcript(calls);
    expect(await manageWorkingSet(messages, 1, budget(), [], blob, pathOf, view(calls, 2))).toBeNull();

    const rerun: Call[] = [...calls.slice(0, 1), { id: 'c', name: 'run_terminal', args: { command: 'npm test' }, result: ran, iteration: 3 }];
    const again = transcript(rerun);
    const result = await manageWorkingSet(again, 1, budget(), [], blob, pathOf, view(rerun, 3));
    expect(result?.byReason).toEqual({ superseded: ['a'] });
  });

  it('keeps the newest non-file results and earlier turns except when superseded', async () => {
    const calls: Call[] = [
      { id: 'old', name: 'grep', args: { pattern: 'x' }, result: body('grep old'), iteration: 1 },
      { id: 'new', name: 'grep', args: { pattern: 'y' }, result: body('grep new'), iteration: 1 },
    ];
    const messages = transcript(calls);
    // runStart after both rows: they are earlier-turn results, never cold here.
    expect(await manageWorkingSet(messages, messages.length, budget(), [], blob, pathOf, view(calls, 9))).toBeNull();
    // In-run: the newest non-file result stays, the older one is cold.
    const inRun = await manageWorkingSet(transcript(calls), 1, budget(), [], blob, pathOf, view(calls, 9));
    expect(inRun?.byReason).toEqual({ cold: ['old'] });
  });
});

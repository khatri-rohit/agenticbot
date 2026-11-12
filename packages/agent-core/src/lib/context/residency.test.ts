import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONTEXT_BUDGET, type ContextBudget } from '@agent/agent-models';

import { CARD_PREFIX, foldResidue, manageWorkingSet, ReadDedupe, type WorkingSetView } from './residency';

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
  it('cards an older read that a later read covers, with a short card that keeps the sha', async () => {
    const calls: Call[] = [
      { id: 'a', name: 'read_file', args: { path: 'a.ts' }, result: read(1, 100, 100), iteration: 1 },
      { id: 'b', name: 'read_file', args: { path: 'a.ts' }, result: read(1, 100, 100, 4_100), iteration: 2 },
    ];
    const messages = transcript(calls);
    const result = await manageWorkingSet(messages, 1, budget(), [], blob, pathOf, view(calls, 2));
    expect(result?.byReason).toEqual({ superseded: ['a'] });
    expect(contentOf(messages, 'a')).toBe('(evicted) read_file {"path":"a.ts"} [1–100] · superseded · 4021 chars · sha256:sha-4021');
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
    expect(contentOf(messages, 'a')).toMatch(/^\(evicted\) read_file \{"path":"a\.ts"\} \[1–50\] · cold · /);
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

  it('past the cap, removes down to the low mark in one pass, least recently touched first, sparing this step', async () => {
    const calls: Call[] = [
      { id: 'a', name: 'read_file', args: { path: 'a.ts' }, result: read(1, 50, 50, 8_000), iteration: 1 },
      { id: 'b', name: 'read_file', args: { path: 'b.ts' }, result: read(1, 50, 50, 8_000), iteration: 2 },
      { id: 'c', name: 'read_file', args: { path: 'c.ts' }, result: read(1, 50, 50, 8_000), iteration: 3 },
    ];
    const messages = transcript(calls);
    // ~6k tokens resident against a 4.5k cap (low mark 2.25k); nothing is cold
    // yet. Trimming to the cap would remove only a; the pass goes to the low
    // mark, so b goes too, and the next results fit without another pass.
    const result = await manageWorkingSet(
      messages, 1, budget({ inRunResidentToolTokens: 4_500, inRunClearAtLeastTokens: 100_000 }), [], blob, pathOf, view(calls, 3),
    );
    expect(result?.byReason).toEqual({ budget: ['b', 'a'] });
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

  it('never removes a sub-agent report or a recall of one, even past the cap', async () => {
    const sha = 'f'.repeat(64);
    const calls: Call[] = [
      { id: 'd', name: 'delegate', args: { profile: 'explore' }, result: `subagent:profile=explore reportSha=${sha}\n${'r'.repeat(6_000)}`, iteration: 1 },
      { id: 'r', name: 'recall', args: { sha256: sha, offset: 6000 }, result: body('rest of report', 6_000), iteration: 2 },
      { id: 'a', name: 'read_file', args: { path: 'a.ts' }, result: read(1, 50, 50, 6_000), iteration: 3 },
      { id: 'b', name: 'read_file', args: { path: 'b.ts' }, result: read(1, 50, 50, 6_000), iteration: 4 },
    ];
    const messages = transcript(calls);
    const result = await manageWorkingSet(
      messages, 1, budget({ inRunResidentToolTokens: 3_000, inRunClearAtLeastTokens: 100_000 }), [], blob, pathOf, view(calls, 5),
    );
    // Only the plain read goes; the report and its recall cost a child run to get back.
    expect(result?.toolCallIds.sort()).toEqual(['a', 'b']);
    expect(contentOf(messages, 'd')).toMatch(/^subagent:/);
    expect(contentOf(messages, 'r')).toMatch(/^rest of report/);
  });

  it('removes reads of a file a finding cites, in a batched pass', async () => {
    const calls: Call[] = [
      { id: 'a', name: 'read_file', args: { path: 'a.ts' }, result: read(1, 50, 50, 3_000), iteration: 1 },
      { id: 'b', name: 'read_file', args: { path: 'b.ts' }, result: read(1, 50, 50, 3_000), iteration: 1 },
    ];
    const messages = transcript(calls);
    const cited = { ...view(calls, 2), isCited: (path: string) => path === 'a.ts' };
    const result = await manageWorkingSet(messages, 1, budget(), [], blob, pathOf, cited);
    expect(result?.byReason).toEqual({ cited: ['a'] });
    expect(contentOf(messages, 'b')).toMatch(/^\[lines/);
  });

  it('makes no pass under the cap when stale results would free too little', async () => {
    const calls: Call[] = [
      { id: 'a', name: 'read_file', args: { path: 'a.ts' }, result: read(1, 50, 50, 1_000), iteration: 1 },
    ];
    const messages = transcript(calls);
    const cited = { ...view(calls, 2), isCited: () => true };
    expect(await manageWorkingSet(messages, 1, budget({ inRunClearAtLeastTokens: 5_000 }), [], blob, pathOf, cited)).toBeNull();
  });
});

describe('foldResidue', () => {
  const card = (n: number) => `${CARD_PREFIX} read_file {"path":"f${n}.ts"} [1–50] · cold · 9000 chars · sha256:${String(n).padStart(64, '0')}`;
  const steps = (count: number, resident: number[] = []): ChatCompletionMessageParam[] =>
    transcript(
      Array.from({ length: count }, (_, i) => ({
        id: `c${i}`,
        name: 'read_file',
        args: { path: `f${i}.ts`, padding: 'p'.repeat(400) },
        result: resident.includes(i) ? read(1, 50, 50, 2_000) : card(i),
        iteration: i + 1,
      })),
    );
  const small = budget({ inRunResidueFoldTokens: 1_000, inRunKeepToolResults: 2 });

  it('folds old steps that hold only cards once residue passes the mark, keeping the newest', async () => {
    const messages = steps(12);
    const before = messages.length;
    const result = await foldResidue(messages, 1, small, []);
    expect(result).not.toBeNull();
    // 10 of 12 steps fold into one recap; the 2 newest stay.
    expect(result?.toolCallIds).toHaveLength(10);
    expect(messages.length).toBe(before - 20 + 1);
    expect(String(messages[1]?.content)).toMatch(/^\(compacted progress\)/);
    // Shas stay recallable from the recap.
    expect(String(messages[1]?.content)).toContain(`sha256:${'0'.repeat(63)}1`);
  });

  it('stops at the first step that still holds resident content', async () => {
    const messages = steps(12, [3]);
    // A lower mark, so three steps' residue is worth a fold (at least half the mark).
    const result = await foldResidue(messages, 1, { ...small, inRunResidueFoldTokens: 600 }, []);
    expect(result?.toolCallIds).toEqual(['c0', 'c1', 'c2']);
    expect(contentOf(messages, 'c3')).toMatch(/^\[lines/);
  });

  it('does not fold a stretch too small to be worth changing the cached prompt', async () => {
    // Only three steps are foldable before a resident one: under half the 1k mark.
    expect(await foldResidue(steps(12, [3]), 1, small, [])).toBeNull();
  });

  it('does nothing under the residue mark', async () => {
    expect(await foldResidue(steps(3), 1, budget({ inRunResidueFoldTokens: 50_000 }), [])).toBeNull();
  });
});

describe('ReadDedupe', () => {
  it('answers an identical search with a pointer until an edit or command', () => {
    const dedupe = new ReadDedupe();
    const result = 'src/a.ts:3:hit';
    expect(dedupe.applySearch('grep', { pattern: 'hit' }, result, 1, 'g1')).toBe(result);
    expect(dedupe.applySearch('grep', { pattern: 'hit' }, result, 2, 'g2')).toMatch(/^\(unchanged since iteration 1\) grep/);
    dedupe.invalidatePath('src/other.ts');
    expect(dedupe.applySearch('grep', { pattern: 'hit' }, result, 3, 'g3')).toBe(result);
  });

  it('flags a re-read of text that was removed as a restore', () => {
    const dedupe = new ReadDedupe();
    const text = read(1, 50, 50);
    expect(dedupe.apply('a.ts', {}, text, 1, 'r1')).toEqual({ text, restored: false });
    dedupe.forget(['r1']);
    expect(dedupe.apply('a.ts', {}, text, 5, 'r2')).toEqual({ text, restored: true });
    // Changed text after an edit is a new read, not a restore.
    dedupe.forget(['r2']);
    dedupe.invalidatePath('a.ts');
    expect(dedupe.apply('a.ts', {}, text, 7, 'r3').restored).toBe(false);
  });
});

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

  it('a cited read is not stale on its own: under the cap it stays', async () => {
    const calls: Call[] = [
      { id: 'a', name: 'read_file', args: { path: 'a.ts' }, result: read(1, 50, 50, 3_000), iteration: 1 },
      { id: 'b', name: 'read_file', args: { path: 'b.ts' }, result: read(1, 50, 50, 3_000), iteration: 1 },
    ];
    const messages = transcript(calls);
    const cited = { ...view(calls, 2), isCited: (path: string) => path === 'a.ts' };
    expect(await manageWorkingSet(messages, 1, budget(), [], blob, pathOf, cited)).toBeNull();
    expect(contentOf(messages, 'a')).toMatch(/^\[lines/);
  });

  it('past the cap, cited reads leave first (traced cited), then least recently touched', async () => {
    const calls: Call[] = [
      { id: 'a', name: 'read_file', args: { path: 'a.ts' }, result: read(1, 50, 50, 8_000), iteration: 1 },
      { id: 'b', name: 'read_file', args: { path: 'b.ts' }, result: read(1, 50, 50, 8_000), iteration: 2 },
      { id: 'c', name: 'read_file', args: { path: 'c.ts' }, result: read(1, 50, 50, 8_000), iteration: 2 },
      { id: 'd', name: 'read_file', args: { path: 'd.ts' }, result: read(1, 50, 50, 8_000), iteration: 3 },
    ];
    const messages = transcript(calls);
    // ~8k tokens resident against a 5k cap (low mark 2.5k): three of four go.
    // c is cited, so it goes before the older a; then a, then b.
    const cited = { ...view(calls, 3), isCited: (path: string) => path === 'c.ts' };
    const result = await manageWorkingSet(
      messages, 1, budget({ inRunResidentToolTokens: 5_000, inRunClearAtLeastTokens: 100_000 }), [], blob, pathOf, cited,
    );
    expect(result?.byReason).toEqual({ cited: ['c'], budget: ['b', 'a'] });
    expect(contentOf(messages, 'c')).toMatch(/ · cited · /);
    expect(contentOf(messages, 'd')).toMatch(/^\[lines/);
  });

  it('makes no pass under the cap when stale results would free too little', async () => {
    const calls: Call[] = [
      { id: 'a', name: 'read_file', args: { path: 'a.ts' }, result: read(1, 50, 50, 1_000), iteration: 1 },
    ];
    const messages = transcript(calls);
    expect(await manageWorkingSet(messages, 1, budget({ inRunClearAtLeastTokens: 5_000 }), [], blob, pathOf, view(calls, 9))).toBeNull();
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

  /** Every tool row's call is issued by an assistant row earlier in the array. */
  const pairingValid = (messages: ChatCompletionMessageParam[]) => {
    const issued = new Set<string>();
    for (const message of messages) {
      if (message.role === 'assistant') for (const call of message.tool_calls ?? []) issued.add(call.id);
      if (message.role === 'tool' && !issued.has(message.tool_call_id)) return false;
    }
    return true;
  };

  it('keeps a step with resident content in place and folds card-only steps before and after it', async () => {
    const messages = steps(12, [3]);
    const result = await foldResidue(messages, 1, small, []);
    expect(result?.toolCallIds).toEqual(['c0', 'c1', 'c2', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
    expect(String(messages[1]?.content)).toMatch(/^\(compacted progress\)/);
    // The resident step sits right after the recap, then the two newest.
    expect(messages[2]?.role === 'assistant' && messages[2].tool_calls?.[0]?.id).toBe('c3');
    expect(contentOf(messages, 'c3')).toMatch(/^\[lines/);
    expect(messages.filter((m) => m.role === 'tool').map((m) => (m as { tool_call_id: string }).tool_call_id))
      .toEqual(['c3', 'c10', 'c11']);
    expect(pairingValid(messages)).toBe(true);
  });

  it('a sub-agent report early in the run does not block folding later card-only steps', async () => {
    const report = `subagent:profile=explore reportSha=${'f'.repeat(64)}\n${'r'.repeat(3_000)}`;
    const messages = steps(12);
    // Step 1 becomes a delegate call whose report must never be removed.
    messages[3] = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'd', type: 'function', function: { name: 'delegate', arguments: '{"profile":"explore"}' } }],
    };
    messages[4] = { role: 'tool', tool_call_id: 'd', content: report };
    const result = await foldResidue(messages, 1, small, []);
    expect(result?.toolCallIds).toEqual(['c0', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
    expect(contentOf(messages, 'd')).toBe(report);
    expect(pairingValid(messages)).toBe(true);
  });

  it('leaves tool_call pairing valid after folding around several live steps', async () => {
    const messages = steps(14, [1, 5, 6, 10]);
    const result = await foldResidue(messages, 1, { ...small, inRunResidueFoldTokens: 600 }, []);
    expect(result).not.toBeNull();
    expect(pairingValid(messages)).toBe(true);
    for (const id of ['c1', 'c5', 'c6', 'c10']) expect(contentOf(messages, id)).toMatch(/^\[lines/);
  });

  it('keeps prior recap lines and appends new ones in order', async () => {
    const messages = steps(12);
    messages.splice(1, 0, { role: 'assistant', content: '(compacted progress)\nheader\n- earlier line one\n- earlier line two' });
    const result = await foldResidue(messages, 1, small, []);
    expect(result?.toolCallIds).toHaveLength(10);
    const recap = String(messages[1]?.content);
    expect(recap.match(/\(compacted progress\)/g)).toHaveLength(1);
    const one = recap.indexOf('earlier line one');
    const two = recap.indexOf('earlier line two');
    const c0 = recap.indexOf('f0.ts');
    const c9 = recap.indexOf('f9.ts');
    expect(one).toBeGreaterThan(-1);
    expect(one).toBeLessThan(two);
    expect(two).toBeLessThan(c0);
    expect(c0).toBeLessThan(c9);
    expect(pairingValid(messages)).toBe(true);
  });

  it('prefixes each recap line with its step, so steps kept in place stay in order', async () => {
    const messages = steps(12, [3]);
    // Steps ran at iterations 10 + index (task state's record), not their position.
    await foldResidue(messages, 1, small, [], { stepOf: (id) => 10 + Number(id.slice(1)) });
    const recap = String(messages[1]?.content);
    expect(recap).toMatch(/^\[step 10\] read_file .*f0\.ts/m);
    expect(recap).toMatch(/^\[step 14\] read_file .*f4\.ts/m);
    expect(recap).not.toMatch(/\[step 13\]/);
    // Without a step source, the step's position among the run's steps.
    const plain = steps(12);
    await foldResidue(plain, 1, small, []);
    expect(String(plain[1]?.content)).toMatch(/^\[step 1\] read_file .*f0\.ts/m);
  });

  it('keeps steps with record_finding calls when asked (no card: their arguments are the only copy)', async () => {
    const messages = steps(12);
    messages[5] = {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'f', type: 'function', function: { name: 'record_finding', arguments: '{"claim":"c","evidence":"a.ts:1"}' } }],
    };
    messages[6] = { role: 'tool', tool_call_id: 'f', content: 'Recorded (verified) — evidence: a.ts:1' };
    const kept = await foldResidue(structuredClone(messages), 1, small, [], { keepFindingCalls: true });
    expect(kept?.toolCallIds).not.toContain('f');
    const folded = await foldResidue(messages, 1, small, []);
    expect(folded?.toolCallIds).toContain('f');
  });

  it('never folds the newest keep-N steps', async () => {
    const messages = steps(12);
    const result = await foldResidue(messages, 1, { ...small, inRunKeepToolResults: 4 }, []);
    expect(result?.toolCallIds).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
    for (const id of ['c8', 'c9', 'c10', 'c11']) expect(contentOf(messages, id)).toBe(card(Number(id.slice(1))));
  });

  it('does not fold a stretch too small to be worth changing the cached prompt', async () => {
    // Residue (mostly live steps' call arguments) passes the mark, but only
    // two card-only steps are foldable: under half the 1k mark.
    expect(await foldResidue(steps(12, [2, 3, 4, 5, 6, 7, 8, 9]), 1, small, [])).toBeNull();
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

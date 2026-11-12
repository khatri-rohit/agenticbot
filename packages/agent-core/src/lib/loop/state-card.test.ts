import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONTEXT_BUDGET, DEFAULT_HARNESS_FLAGS, type TraceEvent } from '@agent/agent-models';

import { TaskStateTracker } from '../state/task-state';
import type { RunState } from './run-state';
import { buildStateCard, CARD_HEADER, withStateCard } from './state-card';

const runId = 'r1';

function state(over: {
  events?: TraceEvent[];
  iterations?: number;
  tools?: string[];
  serialReadTurns?: number;
  partialReads?: Array<[string, number]>;
  stalled?: { idle: number; max: number };
  nearLimit?: boolean;
  advisories?: string[];
  stateCard?: boolean;
  messages?: ChatCompletionMessageParam[];
}): RunState {
  const task = new TaskStateTracker();
  for (const event of over.events ?? []) task.apply(event);
  return {
    task,
    iterations: over.iterations ?? 5,
    posture: 'agent',
    contextBudget: DEFAULT_CONTEXT_BUDGET,
    flags: { ...DEFAULT_HARNESS_FLAGS, stateCard: over.stateCard ?? true },
    tools: { byName: new Map((over.tools ?? ['read_file', 'edit_file', 'run_terminal']).map((name) => [name, {}])) },
    serialReadTurns: over.serialReadTurns ?? 0,
    partialReadsByPath: new Map(over.partialReads ?? []),
    steering: { stalled: () => over.stalled },
    budget: { spent: () => 120_000, nearLimit: () => (over.nearLimit ? { spent: 1, limit: 1 } : undefined) },
    limits: { maxPromptTokens: 1_000_000 },
    advisories: [...(over.advisories ?? [])],
    messages: over.messages ?? [],
  } as unknown as RunState;
}

const edit = (iteration: number, id: string, path: string): TraceEvent[] => [
  { type: 'tool_start', runId, iteration, toolName: 'edit_file', toolCallId: id, args: { path } },
  { type: 'tool_complete', runId, iteration, toolName: 'edit_file', toolCallId: id, durationMs: 0, resultPreview: 'Patched', outcome: 'ok' },
];
const check = (iteration: number, id: string, exitCode: number): TraceEvent[] => [
  { type: 'tool_start', runId, iteration, toolName: 'run_terminal', toolCallId: id, args: { command: 'npm test' } },
  { type: 'tool_complete', runId, iteration, toolName: 'run_terminal', toolCallId: id, durationMs: 0, resultPreview: 'cwd: /w', exitCode },
];

describe('harness card', () => {
  it('stays silent on early steps with nothing to say', () => {
    expect(buildStateCard(state({ iterations: 2 }), 30_000)).toBeNull();
  });

  it('shows phase, working set and an unchecked edit as an open item', () => {
    const card = buildStateCard(state({ events: edit(4, 'e', 'src/a.ts'), iterations: 5 }), 36_000);
    expect(card).not.toBeNull();
    expect(card).toContain(CARD_HEADER);
    expect(card).toMatch(/Phase: change · step 5 · task small · ~36k tokens per call · 120k of 1\.0M run budget used/);
    expect(card).toMatch(/Working set: src\/a\.ts \(edited, unchecked\)/);
    expect(card).toMatch(/Open: Edits since step 4 have no check yet/);
  });

  it('asks for a review once a medium change passes its check, and only then', () => {
    const events = [...edit(2, 'a', 'a.ts'), ...edit(3, 'b', 'b.ts'), ...edit(4, 'c', 'c.ts'), ...check(5, 't', 0)];
    const withDelegate = ['read_file', 'edit_file', 'run_terminal', 'delegate'];
    // The class is promoted on the next model call.
    events.push({ type: 'llm_request', runId, iteration: 6 });
    const card = buildStateCard(state({ events, iterations: 6, tools: withDelegate }), 30_000);
    expect(card).toMatch(/task medium/);
    expect(card).toMatch(/Open: Edits pass the check: run delegate\(review\) once, then report\./);

    const small = [...edit(2, 'a', 'a.ts'), ...check(3, 't', 0), { type: 'llm_request', runId, iteration: 4 } as TraceEvent];
    expect(buildStateCard(state({ events: small, iterations: 4, tools: withDelegate }), 30_000) ?? '').not.toMatch(/review/);
  });

  it('reports a failed check while nothing is pending', () => {
    const card = buildStateCard(state({ events: [...edit(2, 'a', 'a.ts'), ...check(3, 't', 2)], iterations: 4 }), 30_000);
    expect(card).toMatch(/Open: Last check failed: `npm test` exited 2\./);
  });

  it('turns repeated-pattern conditions into advice while they hold, and one-shot advice once', () => {
    const s = state({
      serialReadTurns: 4,
      partialReads: [['big.ts', 3]],
      stalled: { idle: 300_000, max: 1_000_000 },
      nearLimit: true,
      advisories: ['Try the advisor.'],
    });
    const card = buildStateCard(s, 40_000) ?? '';
    expect(card).toMatch(/- 4 turns in a row made one read call, and each turn re-sends ~40k tokens/);
    expect(card).toMatch(/- 3 slices of big\.ts so far: grep for the anchor line/);
    expect(card).toMatch(/- 300k tokens \(30% of the run budget\) since the last edit; about 22 calls left/);
    expect(card).toMatch(/- Run budget nearly spent/);
    expect(card).toMatch(/- Try the advisor\./);
    expect(buildStateCard(s, 40_000) ?? '').not.toMatch(/Try the advisor/);
  });

  it('is appended to the call, not to the live messages, and is off with the flag', () => {
    const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: 'go' }];
    const s = state({ events: edit(4, 'e', 'a.ts') });
    const sent = withStateCard(s, messages, 30_000);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ role: 'user', content: expect.stringContaining(CARD_HEADER) });
    expect(messages).toHaveLength(1);
    expect(withStateCard(state({ events: edit(4, 'e', 'a.ts'), stateCard: false }), messages, 30_000)).toBe(messages);
  });
});

describe('harness card working set', () => {
  const readRow = (id: string, path: string, content: string): ChatCompletionMessageParam[] => [
    { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path }) } }] },
    { role: 'tool', tool_call_id: id, content },
  ];
  const readEvents = (iteration: number, id: string, path: string): TraceEvent[] => [
    { type: 'tool_start', runId, iteration, toolName: 'read_file', toolCallId: id, args: { path } },
    { type: 'tool_complete', runId, iteration, toolName: 'read_file', toolCallId: id, durationMs: 0, resultPreview: '[lines 1–9 of 9]' },
  ];

  it('lists only files whose content is still in the prompt, and counts the rest', () => {
    const messages = [
      { role: 'user', content: 'go' } as ChatCompletionMessageParam,
      ...readRow('a', 'a.ts', '(evicted) read_file {"path":"a.ts"} · not used since iteration 1 · 900 chars · sha256:x'),
      ...readRow('b', 'b.ts', '[lines 1–9 of 9]\nbody'),
    ];
    const card = buildStateCard(
      state({ events: [...readEvents(1, 'a', 'a.ts'), ...readEvents(4, 'b', 'b.ts')], iterations: 5, messages }),
      850,
    ) ?? '';
    expect(card).toMatch(/Working set: b\.ts; 1 file\(s\) read earlier are no longer in full view/);
    expect(card).not.toMatch(/Working set: .*a\.ts/);
    expect(card).toMatch(/~850 tokens per call/);
  });
});

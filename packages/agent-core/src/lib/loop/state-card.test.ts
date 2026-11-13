import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';

import { DEFAULT_CONTEXT_BUDGET, DEFAULT_HARNESS_FLAGS, type TraceEvent } from '@agent/agent-models';

import { TaskStateTracker } from '../state/task-state';
import type { RunState } from './run-state';
import { buildStateCard, CARD_HEADER, recordOverflowText, recordSection, withStateCard } from './state-card';

const runId = 'r1';

function state(over: {
  events?: TraceEvent[];
  iterations?: number;
  tools?: string[];
  serialReadTurns?: number;
  stalled?: { idle: number; max: number };
  nearLimit?: boolean;
  advisories?: string[];
  stateCard?: boolean;
  messages?: ChatCompletionMessageParam[];
  childTokens?: number;
  recordCardTokens?: number;
  recordBlobSha?: string;
}): RunState {
  const task = new TaskStateTracker();
  for (const event of over.events ?? []) task.apply(event);
  return {
    task,
    runId,
    trace: () => undefined,
    iterations: over.iterations ?? 5,
    posture: 'agent',
    contextBudget: { ...DEFAULT_CONTEXT_BUDGET, recordCardTokens: over.recordCardTokens ?? DEFAULT_CONTEXT_BUDGET.recordCardTokens },
    flags: { ...DEFAULT_HARNESS_FLAGS, stateCard: over.stateCard ?? true },
    tools: { byName: new Map((over.tools ?? ['read_file', 'edit_file', 'run_terminal', 'record_finding']).map((name) => [name, {}])) },
    serialReadTurns: over.serialReadTurns ?? 0,
    steering: { stalled: () => over.stalled },
    budget: {
      spent: () => 120_000 + (over.childTokens ?? 0),
      snapshot: () => ({
        own: { promptTokens: 120_000, completionTokens: 0, calls: 1, estimatedCalls: 0 },
        children: { promptTokens: over.childTokens ?? 0, completionTokens: 0, calls: 0, estimatedCalls: 0 },
      }),
      nearLimit: () => (over.nearLimit ? { spent: 1, limit: 1 } : undefined),
    },
    recordBlobSha: over.recordBlobSha,
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
    expect(card).toMatch(/Phase: change · step 5 · task small change · ~36k tokens per call · run budget: 120k own of 1\.0M used/);
    expect(card).toMatch(/Working set: src\/a\.ts \(edited, unchecked\)/);
    expect(card).toMatch(/Open: Edits since step 4 have no check yet/);
  });

  it('shows own and sub-agent spend apart', () => {
    const card = buildStateCard(state({ events: edit(4, 'e', 'src/a.ts'), childTokens: 700_000 }), 36_000);
    expect(card).toMatch(/run budget: 120k own \+ 700k sub-agents of 1\.0M used/);
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
      stalled: { idle: 300_000, max: 1_000_000 },
      nearLimit: true,
      advisories: ['Try the advisor.'],
    });
    const card = buildStateCard(s, 40_000) ?? '';
    expect(card).toMatch(/- 4 turns in a row made one read call, and each turn re-sends ~40k tokens/);
    expect(card).not.toMatch(/slices of/);
    expect(card).toMatch(/- 300k tokens \(30% of the run budget\) since the last evidence \(an edit, a passing check or a recorded finding\); about 22 calls left/);
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

/** A record_finding call as the tracker sees it: recorded when its result comes back. */
const finding = (
  iteration: number,
  id: string,
  claim: string,
  evidence: string,
  extra: { topic?: string; label?: string } = {},
): TraceEvent[] => [
  {
    type: 'tool_start',
    runId,
    iteration,
    toolName: 'record_finding',
    toolCallId: id,
    args: { claim, evidence, ...(extra.topic ? { topic: extra.topic } : {}) },
  },
  {
    type: 'tool_complete',
    runId,
    iteration,
    toolName: 'record_finding',
    toolCallId: id,
    durationMs: 0,
    resultPreview: `Recorded (${extra.label ?? 'verified'}) — evidence: ${evidence}`,
  },
];

describe('harness card task record', () => {
  const research: TraceEvent = { type: 'run_start', runId, model: 'm', taskShape: 'research' };

  it('shows recorded findings with their evidence, even on an early step', () => {
    const card = buildStateCard(
      state({ events: [research, ...finding(1, 'f1', 'The cap is 20 tiles per tab', 'src/TileRibbon.tsx:104')], iterations: 2 }),
      5_000,
    ) ?? '';
    expect(card).toMatch(/task small research/);
    expect(card).toMatch(/Record \(1 finding\(s\); answer from these and cite their evidence\):/);
    expect(card).toMatch(/- The cap is 20 tiles per tab — src\/TileRibbon\.tsx:104$/m);
  });

  it('marks unverified findings', () => {
    const events = [research, ...finding(1, 'f1', 'Port is 80', 'a.ts:3', { label: 'unverified: quote not found' })];
    const card = buildStateCard(state({ events, iterations: 2 }), 5_000) ?? '';
    expect(card).toMatch(/- Port is 80 — a\.ts:3 \(unverified\)$/m);
  });

  /** `count` findings over a few topics, each ~120 characters. */
  const many = (count: number): TraceEvent[] =>
    Array.from({ length: count }, (_, i) =>
      finding(1 + Math.floor(i / 10), `f${i}`, `Fact number ${i} about the system, padded to a typical length for a finding ${'.'.repeat(20)}`, `src/f${i}.ts:${i + 1}`, {
        topic: `t${i % 3}`,
      }),
    ).flat();

  it('shows the whole record while it fits, with no sha', () => {
    const findings = many(20);
    const card = buildStateCard(state({ events: [research, ...findings], recordBlobSha: 'a'.repeat(64) }), 5_000) ?? '';
    expect(card).toMatch(/Record \(20 finding\(s\)/);
    expect(card).not.toMatch(/not shown|full record/);
  });

  it('past its budget shows the newest findings, a per-topic count and the full record sha', () => {
    const card = buildStateCard(
      state({ events: [research, ...many(300)], recordCardTokens: 2_000, recordBlobSha: 'a'.repeat(64) }),
      5_000,
    ) ?? '';
    expect(card).toMatch(/Record \(300 finding\(s\)/);
    expect(card).toMatch(/- \(\d+ older finding\(s\) not shown, by topic: t\d \d+, t\d \d+, t\d \d+\)/);
    expect(card).toContain(`- (full record: recall sha256:${'a'.repeat(64)})`);
    expect(card).toContain('Fact number 299 ');
    expect(card).not.toContain('Fact number 0 ');
  });

  it('property: the record section never exceeds its budget, and hidden findings are in the overflow text', () => {
    for (const tokens of [600, 2_000, DEFAULT_CONTEXT_BUDGET.recordCardTokens]) {
      for (const count of [1, 10, 60, 250, 1_000]) {
        const tracker = new TaskStateTracker();
        for (const event of [research, ...many(count)]) tracker.apply(event);
        const findings = tracker.snapshot().evidence.findings;
        expect(findings).toHaveLength(count);
        const section = recordSection(findings, tokens, 'a'.repeat(64));
        expect(section.join('\n').length).toBeLessThanOrEqual(tokens * 4);
        const overflow = recordOverflowText(findings, tokens);
        const shown = section.filter((line) => line.startsWith('- Fact') || line.startsWith('- [t')).length;
        if (shown < count) {
          expect(overflow).not.toBeNull();
          for (const finding of findings) expect(overflow).toContain(finding.claim);
        } else {
          expect(overflow).toBeNull();
        }
      }
    }
  });

  it('words stall and budget advice for research: answer from the record, do not run a check', () => {
    const card = buildStateCard(
      state({ events: [research], stalled: { idle: 300_000, max: 1_000_000 }, nearLimit: true }),
      40_000,
    ) ?? '';
    expect(card).toMatch(/Record what you have confirmed with record_finding and answer from the record/);
    expect(card).toMatch(/stop searching\. Answer now from what is recorded/);
    expect(card).not.toMatch(/run the check/);
  });

  it('words stall and budget advice neutrally while the shape is unknown', () => {
    const unknown: TraceEvent = { type: 'run_start', runId, model: 'm', taskShape: 'unknown' };
    const card = buildStateCard(
      state({ events: [unknown], stalled: { idle: 300_000, max: 1_000_000 }, nearLimit: true }),
      40_000,
    ) ?? '';
    expect(card).toMatch(/task small unknown/);
    expect(card).toMatch(
      /Act on what you have: make the change if one was asked; otherwise record what you confirmed with record_finding and answer from the record\./,
    );
    expect(card).not.toMatch(/Act on what you have: make the change\./);
    expect(card).toMatch(/finish the current step, verify any edits once, and report what is done and what is left/);
    expect(card).not.toMatch(/run the check/);

    const noRecord = buildStateCard(
      state({ events: [unknown], stalled: { idle: 300_000, max: 1_000_000 }, tools: ['read_file', 'edit_file'] }),
      40_000,
    ) ?? '';
    expect(noRecord).toMatch(/make the change if one was asked; otherwise answer from what you have confirmed\./);
    expect(noRecord).not.toMatch(/record_finding/);
  });
});

describe('harness card re-read item', () => {
  const restored = (iteration: number, path: string): TraceEvent => ({
    type: 'context_restored',
    runId,
    iteration,
    toolCallId: `x-${path}`,
    path,
  });
  const item = /Open: Re-read after removal: (.+)\. Record the facts you need from them with record_finding so they need not be read again\./;

  it('names files read again after removal that no finding cites, at most 3', () => {
    expect(buildStateCard(state({ events: [] }), 5_000) ?? '').not.toMatch(item);
    const traced: TraceEvent[] = [];
    const s = state({ events: ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((path) => restored(3, path)) });
    (s as unknown as { trace: (event: TraceEvent) => void }).trace = (event) => traced.push(event);
    const sent = withStateCard(s, [], 5_000);
    expect(String(sent[0]?.content)).toMatch(/Open: Re-read after removal: a\.ts, b\.ts, c\.ts, \+1 more\./);
    expect(traced).toEqual([expect.objectContaining({ kind: 'card', ids: expect.arrayContaining(['open:reread']) })]);
  });

  it('drops a file once a finding cites it', () => {
    const events = [restored(3, 'a.ts'), restored(3, 'b.ts'), ...finding(4, 'f1', 'A sets the port', 'a.ts:3')];
    const card = buildStateCard(state({ events, iterations: 5 }), 5_000) ?? '';
    expect(card).toMatch(/Open: Re-read after removal: b\.ts\./);
    const all = [...events, ...finding(4, 'f2', 'B reads it', 'b.ts:7')];
    expect(buildStateCard(state({ events: all, iterations: 5 }), 5_000) ?? '').not.toMatch(item);
  });

  it('is not shown for a change, or without record_finding', () => {
    const events = [restored(3, 'a.ts')];
    expect(buildStateCard(state({ events: [...events, ...edit(4, 'e', 'z.ts')], iterations: 6 }), 5_000) ?? '').not.toMatch(item);
    expect(buildStateCard(state({ events, tools: ['read_file'] }), 5_000) ?? '').not.toMatch(item);
  });
});


describe('harness card and sub-agent results', () => {
  it('shows merged child findings in the record and their gaps as what is left to check', () => {
    const merged: TraceEvent = {
      type: 'child_findings',
      runId,
      iteration: 3,
      subRunId: 'child-1',
      findings: [{ claim: 'Max 20 tiles', evidence: 'src/TileRibbon.tsx:105', verification: 'verified', iteration: 0 }],
      openQuestions: ['where the tile cap toast is shown', 'mobile layout limits', 'TV refresh options', 'export naming'],
    };
    const card = buildStateCard(state({ events: [merged], iterations: 4 }), 5_000) ?? '';
    expect(card).toMatch(/- Max 20 tiles — src\/TileRibbon\.tsx:105/);
    expect(card).toMatch(/Open: Sub-agent gaps to check \(their findings are in the record; do not re-verify those\): mobile layout limits; TV refresh options; export naming \(\+1 more\)/);
  });
});

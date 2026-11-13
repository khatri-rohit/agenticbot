/**
 * The sub-agent runner applies the effort budget end to end: the limits it
 * computes are the ones the child run stops at, the brief names the same
 * number, and `child_budget` records them. (childAllocation itself is
 * covered by limits-consistency.test.ts; this covers the wiring.)
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';

import {
  childAllocation,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_HARNESS_FLAGS,
  REPORT_MAX_CHARS,
  THOROUGHNESS_TOOL_CALLS,
  type RunUsage,
  type SubagentSpec,
  type TraceEvent,
} from '@agent/agent-models';

import { RunManager } from '../run/run-manager';
import { TaskStateTracker } from '../state/task-state';
import type { ModelCallFn, SubagentParent } from '../loop/types';
import { getSubagentProfile } from './profiles';
import { createSubagentRunner, type SubagentHost } from './runner';
import { DIGEST_MAX_CHARS, UNTRUSTED_SUBAGENT_BEGIN, UNTRUSTED_SUBAGENT_END } from './types';

const PROMPT_PER_CALL = 20_000;

const REPORT_ONLY_TEXT = 'only `report` is available';

type Seen = { messages: ChatCompletionMessageParam[]; toolCount: number }[];

/**
 * A child model that keeps searching, `batch` globs per turn. Uncooperative
 * by default: only its limits end the run. Cooperative: once a tool row says
 * only `report` is left, it calls report.
 */
function searcher(
  briefs: string[],
  promptPerCall: number,
  options: { batch?: number; cooperative?: boolean; longReport?: boolean; seen?: Seen } = {},
): ModelCallFn {
  const batch = options.batch ?? 1;
  let n = 0;
  return async (_model, messages, tools) => {
    const list = messages as ChatCompletionMessageParam[];
    options.seen?.push({ messages: [...list], toolCount: tools.definitions.length });
    const brief = list.find((message) => message.role === 'user');
    if (n === 0 && typeof brief?.content === 'string') briefs.push(brief.content);
    n += 1;
    const usage = { promptTokens: promptPerCall, completionTokens: 10 };
    if (tools.definitions.length === 0) {
      return { content: 'Stopped at the limit. Found: nothing yet. Open: everything.', toolCalls: [], finishReason: 'stop', usage };
    }
    const refused = list.some(
      (message) => message.role === 'tool' && typeof message.content === 'string' && message.content.includes(REPORT_ONLY_TEXT),
    );
    if (options.cooperative && refused) {
      const args = {
        status: 'partial',
        summary: 'Searched the workspace; budget ran out.',
        findings: [
          { claim: 'a is exported', evidence: 'a.ts:1' },
          // A long report, sent twice: the one-time refusal, then taken.
          ...(options.longReport
            ? Array.from({ length: 120 }, (_, i) => ({ claim: `finding ${i} ${'x'.repeat(100)}`, evidence: `f${i}.ts:1` }))
            : []),
        ],
        openQuestions: ['where a is used'],
      };
      return {
        content: '',
        toolCalls: [{ id: `r${n}`, type: 'function', function: { name: 'report', arguments: JSON.stringify(args) } }],
        finishReason: 'tool_calls',
        usage,
      };
    }
    return {
      content: '',
      toolCalls: Array.from({ length: batch }, (_, i) => ({
        id: `g${n}-${i}`,
        type: 'function' as const,
        function: { name: 'glob', arguments: JSON.stringify({ pattern: `**/*${n}-${i}*` }) },
      })),
      finishReason: 'tool_calls',
      usage,
    };
  };
}

async function harness(
  promptPerCall = PROMPT_PER_CALL,
  options: { batch?: number; cooperative?: boolean; longReport?: boolean } = {},
) {
  const seen: Seen = [];
  const root = await mkdtemp(path.join(os.tmpdir(), 'runner-'));
  await writeFile(path.join(root, 'a.ts'), 'export const a = 1;\n');
  const traces = new Map<string, TraceEvent[]>();
  const briefs: string[] = [];
  let threads = 0;
  const host: SubagentHost = {
    createThread: async () => ({ id: `child-${++threads}` }),
    childInfo: () => undefined,
    loadMessages: async () => [],
    append: async () => undefined,
    putBlob: async () => 'b'.repeat(64),
    readBlob: async () => '',
    writeLastRun: async () => undefined,
    modelFor: (_role, parentModel) => parentModel,
    modelCall: async () => searcher(briefs, promptPerCall, { ...options, seen }),
    contextBudget: async () => DEFAULT_CONTEXT_BUDGET,
    agentsMd: async () => '',
    trace: (threadId) => {
      const list = traces.get(threadId) ?? [];
      traces.set(threadId, list);
      return (event) => list.push(event);
    },
  };
  const charged: RunUsage[] = [];
  const parent = (remainingPromptTokens?: number, parentEvents?: TraceEvent[]): SubagentParent => ({
    runId: 'parent-run',
    threadId: 'parent-thread',
    model: 'test-model',
    depth: 0,
    posture: 'agent',
    signal: new AbortController().signal,
    workspaceRoot: root,
    toolNames: ['glob', 'grep', 'read_file', 'recall'],
    contextBudget: DEFAULT_CONTEXT_BUDGET,
    flags: DEFAULT_HARNESS_FLAGS,
    ...(remainingPromptTokens !== undefined ? { remainingPromptTokens } : {}),
    forkMessages: () => [],
    webTrust: () => ({ urls: [], sources: [] }),
    chargeUsage: (usage) => charged.push(usage),
    ...(parentEvents ? { trace: (event: TraceEvent) => parentEvents.push(event), iteration: () => 1 } : {}),
  });
  const spawn = createSubagentRunner({ runManager: new RunManager(), host });
  const run = (spec: Partial<SubagentSpec>, remaining?: number, parentEvents?: TraceEvent[]) =>
    spawn({ profile: 'explore', objective: 'find things', scope: 'the workspace', ...spec }, parent(remaining, parentEvents));
  return { run, traces, briefs, charged, seen };
}

const budgetOf = (events: TraceEvent[] | undefined) =>
  events?.find((event): event is Extract<TraceEvent, { type: 'child_budget' }> => event.type === 'child_budget');

const reportOnlyGuards = (events: TraceEvent[] | undefined) =>
  (events ?? [])
    .filter((event): event is Extract<TraceEvent, { type: 'policy_decision' }> => event.type === 'policy_decision')
    .filter((event) => event.kind === 'guard')
    .flatMap((event) => event.ids)
    .filter((id) => id.startsWith('report_only:'));

describe('sub-agent runner budgets', () => {
  it('a quick child that never reports stops at its call budget, and the brief and trace name the same limit', async () => {
    // Cheap calls, so the call budget binds before the token budget.
    const { run, traces, briefs, seen } = await harness(2_000);
    const result = await run({ thoroughness: 'quick' });
    const events = traces.get(result.subThreadId);
    const budget = budgetOf(events)!;
    const calls = THOROUGHNESS_TOOL_CALLS.quick;

    expect(budget).toMatchObject({ profile: 'explore', thoroughness: 'quick', maxToolCalls: calls + 1 });
    expect(result.status).toBe('incomplete');
    expect(result.limitReason).toMatch(/^limit\.tools/);
    // Other tools stop one short: the last call is kept for `report`.
    expect(result.toolCalls).toBe(budget.maxToolCalls - 1);
    expect(reportOnlyGuards(events).length).toBeGreaterThan(0);
    expect(briefs[0]).toContain(`up to ${calls} tool calls`);
    expect(briefs[0]).toContain('only `report` remains');
    // The tools-off handoff asks for a bounded report with the gaps.
    const last = seen.at(-1)!;
    expect(last.toolCount).toBe(0);
    const instruction = String(last.messages.at(-1)?.content ?? '');
    expect(instruction).toContain(`under ${REPORT_MAX_CHARS.toLocaleString('en-US')} characters`);
    expect(instruction).toMatch(/Open:/);
    // The handoff the parent reads says what is still open.
    expect(result.digest).toContain('Open: everything');
  });

  it('a cooperative child whose batch runs past the budget is refused down to `report`, and reports', async () => {
    const { run, traces } = await harness(2_000, { batch: 3, cooperative: true });
    const result = await run({ thoroughness: 'quick' });
    const events = traces.get(result.subThreadId);
    const budget = budgetOf(events)!;

    expect(result.status).toBe('completed');
    expect(result.limitReason).toBeUndefined();
    expect(result.toolCalls).toBeLessThanOrEqual(budget.maxToolCalls);
    expect(result.digest).toContain('Status: partial');
    expect(result.digest).toContain('a.ts:1');
    expect(result.digest).toContain('where a is used');
    expect(result.digest).not.toContain('…(cut');
    expect(reportOnlyGuards(events)).toContain('report_only:glob');
    expect(events?.some((event) => event.type === 'limit')).toBe(false);
  });

  it('a cooperative child with an over-long report gets a bounded digest that loses nothing', async () => {
    const { run } = await harness(2_000, { batch: 3, cooperative: true, longReport: true });
    const result = await run({ thoroughness: 'quick' });
    const body = result.digest.slice(
      UNTRUSTED_SUBAGENT_BEGIN.length + 1,
      -(UNTRUSTED_SUBAGENT_END.length + 1),
    );

    expect(result.status).toBe('completed');
    expect(body.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(body).not.toContain('…(cut');
    expect(body).toContain('Status: partial');
    expect(body).toContain('a.ts:1');
    expect(body).toContain('where a is used');
    expect(body).toMatch(/\n\(\d+ more findings in the full report: recall sha256:b{64}\)\n/);
  });

  it('a brief without an effort gets the profile default (explore: medium), not the 450-call ceiling', async () => {
    const { run, traces } = await harness();
    const result = await run({});
    const budget = budgetOf(traces.get(result.subThreadId))!;
    expect(getSubagentProfile('explore')?.defaultThoroughness).toBe('medium');
    expect(budget.thoroughness).toBe('medium');
    expect(budget.maxToolCalls).toBe(THOROUGHNESS_TOOL_CALLS.medium + 1);
    expect(result.toolCalls).toBeLessThanOrEqual(budget.maxToolCalls);
  });

  it('at a realistic prompt size the token budget can bind first; either way the child stops inside its allocation', async () => {
    const { run, traces } = await harness(PROMPT_PER_CALL);
    const result = await run({ thoroughness: 'quick' });
    const budget = budgetOf(traces.get(result.subThreadId))!;
    expect(result.limitReason).toMatch(/^limit\.(tools|tokens)/);
    expect(result.toolCalls).toBeLessThanOrEqual(budget.maxToolCalls);
    expect(result.usage.own.promptTokens).toBeLessThanOrEqual(budget.maxPromptTokens + 2 * PROMPT_PER_CALL);
  });

  it('a child under a small parent budget stops at its token share, within one call', async () => {
    const { run, traces, charged } = await harness();
    const remaining = 400_000;
    const result = await run({ thoroughness: 'medium' }, remaining);
    const budget = budgetOf(traces.get(result.subThreadId))!;
    const expected = childAllocation({
      profile: getSubagentProfile('explore')!.limits,
      thoroughness: 'medium',
      parentRemaining: remaining,
    })!;
    expect(budget.maxPromptTokens).toBe(expected.maxPromptTokens);
    expect(budget.parentRemaining).toBe(remaining);
    expect(result.limitReason).toMatch(/^limit\.tokens/);
    // The budget is checked before a call, so one call (plus the tools-off handoff) can cross it.
    expect(result.usage.own.promptTokens).toBeLessThanOrEqual(budget.maxPromptTokens + 2 * PROMPT_PER_CALL);
    // Live roll-up: charged turn by turn while it ran, and in total exactly what it spent.
    expect(charged.length).toBeGreaterThan(1);
    const total = charged.reduce((sum, usage) => sum + usage.own.promptTokens + usage.children.promptTokens, 0);
    expect(total).toBe(result.usage.own.promptTokens + result.usage.children.promptTokens);
    // The child's trace closes with what it spent and delivered.
    const finish = traces.get(result.subThreadId)?.find((event) => event.type === 'child_finish');
    expect(finish).toMatchObject({ type: 'child_finish', status: 'incomplete', reportStatus: 'partial', promptTokens: total });
  });

  it('caps a first-pass thorough brief to medium and says so in the parent trace', async () => {
    const { run, traces } = await harness(2_000);
    const parentEvents: TraceEvent[] = [];
    const result = await run({ thoroughness: 'thorough' }, undefined, parentEvents);
    expect(budgetOf(traces.get(result.subThreadId))).toMatchObject({ thoroughness: 'medium' });
    expect(parentEvents).toContainEqual(expect.objectContaining({ type: 'policy_decision', kind: 'delegation', ids: ['effort_capped:thorough'] }));
  });

  it('refuses a brief whose paths overlap a running sub-agent, and lets a disjoint one start', async () => {
    const { run } = await harness(2_000);
    const parentEvents: TraceEvent[] = [];
    const first = run({ objective: 'dashboard facts', paths: ['src/Components/DashBoard'] }, undefined, parentEvents);
    const overlapping = await run({ objective: 'dashboard file only', paths: ['src/Components/DashBoard/DashBoard.tsx'] }, undefined, parentEvents);
    const disjoint = run({ objective: 'menu facts', paths: ['src/Components/DataViewer'] }, undefined, parentEvents);
    expect(overlapping.status).toBe('error');
    expect(overlapping.digest).toMatch(/Not started: src\/Components\/DashBoard\/DashBoard\.tsx is already covered by a running sub-agent \("dashboard facts"\)/);
    expect(parentEvents).toContainEqual(expect.objectContaining({ kind: 'delegation', ids: ['delegate_overlap:src/Components/DashBoard/DashBoard.tsx'] }));
    expect((await disjoint).status).not.toBe('error');
    await first;
    // Once the first has settled, its paths are free again.
    expect((await run({ objective: 'dashboard again', paths: ['src/Components/DashBoard'] })).status).not.toBe('error');
  });

  it('refuses a child when the parent has nothing left to share', async () => {
    const { run, traces } = await harness();
    const result = await run({ thoroughness: 'quick' }, 0);
    expect(result.status).toBe('error');
    expect(result.digest).toMatch(/No run budget left for a sub-agent/);
    expect([...traces.values()].flat().some((event) => event.type === 'child_budget')).toBe(false);
  });
});

describe('sub-agent findings reach the parent (phase 4)', () => {
  type Turn = Awaited<ReturnType<ModelCallFn>>;
  const usage = { promptTokens: 1_000, completionTokens: 10 };
  const calls = (n: number, list: Array<[string, Record<string, unknown>]>): Turn => ({
    content: '',
    toolCalls: list.map(([name, args], i) => ({ id: `c${n}-${i}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } })),
    finishReason: 'tool_calls',
    usage,
  });

  /** A child that follows `script` turn by turn, then keeps globbing; tools-off calls get a plain handoff. */
  function scripted(script: Array<Array<[string, Record<string, unknown>]>>): ModelCallFn {
    let n = 0;
    return async (_model, _messages, tools) => {
      n += 1;
      if (tools.definitions.length === 0) return { content: 'Stopped early.', toolCalls: [], finishReason: 'stop', usage };
      return calls(n, script[n - 1] ?? [['glob', { pattern: `**/*${n}*` }]]);
    };
  }

  async function delegate(model: ModelCallFn) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'runner-findings-'));
    await writeFile(path.join(root, 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
    const host: SubagentHost = {
      createThread: async () => ({ id: 'child-1' }),
      childInfo: () => undefined,
      loadMessages: async () => [],
      append: async () => undefined,
      putBlob: async () => 'b'.repeat(64),
      readBlob: async () => '',
      writeLastRun: async () => undefined,
      modelFor: (_role, parentModel) => parentModel,
      modelCall: async () => model,
      contextBudget: async () => DEFAULT_CONTEXT_BUDGET,
      agentsMd: async () => '',
      trace: () => () => undefined,
    };
    const parentEvents: TraceEvent[] = [];
    const parent: SubagentParent = {
      runId: 'parent-run',
      threadId: 'parent-thread',
      model: 'test-model',
      depth: 0,
      posture: 'agent',
      signal: new AbortController().signal,
      workspaceRoot: root,
      toolNames: ['glob', 'grep', 'read_file', 'recall', 'record_finding'],
      contextBudget: DEFAULT_CONTEXT_BUDGET,
      flags: DEFAULT_HARNESS_FLAGS,
      forkMessages: () => [],
      webTrust: () => ({ urls: [], sources: [] }),
      chargeUsage: () => undefined,
      trace: (event) => parentEvents.push(event),
      iteration: () => 7,
    };
    const spawn = createSubagentRunner({ runManager: new RunManager(), host });
    const result = await spawn({ profile: 'explore', objective: 'find a and b', scope: 'a.ts', thoroughness: 'quick' }, parent);
    const merged = parentEvents.filter((event): event is Extract<TraceEvent, { type: 'child_findings' }> => event.type === 'child_findings');
    return { result, merged };
  }

  it('builds the report from what the child recorded (checked) plus its report call, and merges it into the parent', async () => {
    const { result, merged } = await delegate(
      scripted([
        [
          ['record_finding', { claim: 'b is "export const b"', evidence: 'a.ts:9' }],
          ['record_finding', { claim: 'a is a constant', evidence: 'a.ts:1' }],
        ],
        [['report', { status: 'done', summary: 'Found a and b.', findings: [{ claim: 'a is a constant', evidence: 'a.ts:1' }, { claim: 'only in the report', evidence: 'a.ts:1' }] }]],
      ]),
    );
    expect(result.reportStatus).toBe('done');
    expect(result.findings?.map((finding) => [finding.claim, finding.evidence, finding.verification])).toEqual([
      // Recorded first, in order; the off line was corrected by the check.
      ['b is "export const b"', 'a.ts:2', 'corrected'],
      ['a is a constant', 'a.ts:1', 'verified'],
      // Only in the report call: kept, not checked.
      ['only in the report', 'a.ts:1', 'skipped'],
    ]);
    expect(result.digest).toContain('b is "export const b" (a.ts:2)');
    expect(result.digest).not.toContain('…(cut');

    // I9: what the parent's task state ends with is exactly what the child delivered.
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ runId: 'parent-run', iteration: 7, subRunId: result.subRunId });
    const parentState = new TaskStateTracker();
    for (const event of merged) parentState.apply(event);
    const snapshot = parentState.snapshot();
    expect(snapshot.evidence.findings.map((finding) => finding.claim)).toEqual(result.findings?.map((finding) => finding.claim));
    expect(snapshot.evidence.findings.every((finding) => finding.source === result.subRunId)).toBe(true);
    expect(parentState.isCited('a.ts')).toBe(true);
    expect(snapshot.shape).toBe('research');
  });

  it('a child that stops without report still delivers what it recorded, as partial', async () => {
    // Records once, then globs until the budget refuses everything but report, and never reports.
    const { result, merged } = await delegate(scripted([[['record_finding', { claim: 'a is a constant', evidence: 'a.ts:1' }]]]));
    expect(result.status).toBe('incomplete');
    expect(result.reportStatus).toBe('partial');
    expect(result.findings?.map((finding) => finding.claim)).toEqual(['a is a constant']);
    expect(result.digest).toContain('Status: partial');
    expect(merged[0]?.findings.map((finding) => finding.claim)).toEqual(['a is a constant']);
  });

  it('open questions make the work partial and become the parent gaps to check', async () => {
    const { result, merged } = await delegate(
      scripted([[['report', { status: 'done', summary: 'Mostly found.', openQuestions: ['where b is used'] }]]]),
    );
    expect(result.reportStatus).toBe('partial');
    expect(result.openQuestions).toEqual(['where b is used']);
    const parentState = new TaskStateTracker();
    for (const event of merged) parentState.apply(event);
    expect(parentState.snapshot().childGaps).toEqual(['where b is used']);
  });
});

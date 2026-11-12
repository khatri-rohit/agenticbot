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
  emptyRunUsage,
  REPORT_MAX_CHARS,
  THOROUGHNESS_TOOL_CALLS,
  type RunUsage,
  type SubagentSpec,
  type TraceEvent,
} from '@agent/agent-models';

import { RunManager } from '../run/run-manager';
import type { ModelCallFn, SubagentParent } from '../loop/types';
import { getSubagentProfile } from './profiles';
import { createSubagentRunner, type SubagentHost } from './runner';

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
  options: { batch?: number; cooperative?: boolean; seen?: Seen } = {},
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
        findings: [{ claim: 'a is exported', evidence: 'a.ts:1' }],
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
  options: { batch?: number; cooperative?: boolean } = {},
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
  const parent = (remainingPromptTokens?: number): SubagentParent => ({
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
  });
  const spawn = createSubagentRunner({ runManager: new RunManager(), host });
  const run = (spec: Partial<SubagentSpec>, remaining?: number) =>
    spawn({ profile: 'explore', objective: 'find things', scope: 'the workspace', ...spec }, parent(remaining));
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
    const result = await run({ thoroughness: 'thorough' }, remaining);
    const budget = budgetOf(traces.get(result.subThreadId))!;
    const expected = childAllocation({
      profile: getSubagentProfile('explore')!.limits,
      thoroughness: 'thorough',
      parentRemaining: remaining,
    })!;
    expect(budget.maxPromptTokens).toBe(expected.maxPromptTokens);
    expect(budget.parentRemaining).toBe(remaining);
    expect(result.limitReason).toMatch(/^limit\.tokens/);
    // The budget is checked before a call, so one call (plus the tools-off handoff) can cross it.
    expect(result.usage.own.promptTokens).toBeLessThanOrEqual(budget.maxPromptTokens + 2 * PROMPT_PER_CALL);
    // The parent is charged what the child spent.
    expect(charged.at(-1)?.own.promptTokens ?? emptyRunUsage().own.promptTokens).toBe(result.usage.own.promptTokens);
  });

  it('refuses a child when the parent has nothing left to share', async () => {
    const { run, traces } = await harness();
    const result = await run({ thoroughness: 'quick' }, 0);
    expect(result.status).toBe('error');
    expect(result.digest).toMatch(/No run budget left for a sub-agent/);
    expect([...traces.values()].flat().some((event) => event.type === 'child_budget')).toBe(false);
  });
});

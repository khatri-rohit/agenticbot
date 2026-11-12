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

/** A child model that never stops searching: only its limits end the run. */
function endlessSearch(briefs: string[], promptPerCall: number): ModelCallFn {
  let n = 0;
  return async (_model, messages, tools) => {
    const brief = (messages as ChatCompletionMessageParam[]).find((message) => message.role === 'user');
    if (n === 0 && typeof brief?.content === 'string') briefs.push(brief.content);
    n += 1;
    const usage = { promptTokens: promptPerCall, completionTokens: 10 };
    if (tools.definitions.length === 0) {
      return { content: 'Stopped at the limit. Found: nothing yet. Open: everything.', toolCalls: [], finishReason: 'stop', usage };
    }
    return {
      content: '',
      toolCalls: [{ id: `g${n}`, type: 'function', function: { name: 'glob', arguments: JSON.stringify({ pattern: `**/*${n}*` }) } }],
      finishReason: 'tool_calls',
      usage,
    };
  };
}

async function harness(promptPerCall = PROMPT_PER_CALL) {
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
    modelCall: async () => endlessSearch(briefs, promptPerCall),
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
  return { run, traces, briefs, charged };
}

const budgetOf = (events: TraceEvent[] | undefined) =>
  events?.find((event): event is Extract<TraceEvent, { type: 'child_budget' }> => event.type === 'child_budget');

describe('sub-agent runner budgets', () => {
  it('a quick child stops at its call budget, and the brief and trace name the same limit', async () => {
    // Cheap calls, so the call budget binds before the token budget.
    const { run, traces, briefs } = await harness(2_000);
    const result = await run({ thoroughness: 'quick' });
    const budget = budgetOf(traces.get(result.subThreadId))!;
    const calls = THOROUGHNESS_TOOL_CALLS.quick;

    expect(budget).toMatchObject({ profile: 'explore', thoroughness: 'quick', maxToolCalls: calls + 1 });
    expect(result.status).toBe('incomplete');
    expect(result.limitReason).toMatch(/^limit\.tools/);
    expect(result.toolCalls).toBeLessThanOrEqual(budget.maxToolCalls);
    expect(briefs[0]).toContain(`up to ${calls} tool calls`);
    // The handoff the parent reads says what is still open.
    expect(result.digest).toContain('Open: everything');
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

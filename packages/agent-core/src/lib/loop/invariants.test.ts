/**
 * Harness invariants over a reacting model (v2 build plan, phase 0).
 *
 * Scripted replays pin what the loop does for a fixed script; they cannot
 * show feedback loops, because a script never reacts to what the harness
 * did. The model here does: it works a fake workspace with planted facts,
 * re-reads whatever it needs that is no longer in view, can repeat a
 * search, delegate, edit and run a check. Each invariant is a property the
 * v2 design promises, measured on the trace of such runs.
 *
 * Invariants the current code does not meet yet are `it.fails`: the test
 * passes while the property is broken and fails once a later phase fixes
 * it, which forces the marker to be removed. Each names the phase that
 * owns it.
 */
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';

import {
  childAllocation,
  DEFAULT_CONTEXT_BUDGET,
  type ModelTurn,
  type PendingToolCall,
  type TraceEvent,
} from '@agent/agent-models';

import { createToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';
import { runLoop } from './loop';
import type { ModelCallFn, RunLoopConfig } from './types';

// ---------------------------------------------------------------- workspace

type Workspace = Map<string, string>;

/**
 * `files` files of about `chars` characters. File i has a searchable anchor
 * on line 2 and its fact (FACT-i) on line 7, so a search finds where a fact
 * is but only a read shows it.
 */
function workspace(files: number, chars: number): Workspace {
  const out: Workspace = new Map();
  for (let i = 1; i <= files; i++) {
    const lines = Array.from({ length: Math.max(10, Math.ceil(chars / 60)) }, (_, n) =>
      n === 1
        ? `// anchor fact-${i}`.padEnd(59, ' ')
        : n === 6
          ? `export const fact${i} = 'FACT-${i}';`.padEnd(59, ' ')
          : `// filler line ${n + 1} of file ${i}`.padEnd(59, '.'),
    );
    out.set(`src/f${i}.ts`, lines.join('\n'));
  }
  return out;
}

function tool(name: string, stage: Tool['stage'], execute: Tool['execute'], extra: Partial<Tool> = {}): Tool {
  return {
    definition: { type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } },
    guidance: { whenToUse: ['sim'], whenNotToUse: ['never'], usage: ['call'] },
    stage,
    execute,
    ...extra,
  };
}

function tools(ws: Workspace, report: string): Tool[] {
  const read = tool('read_file', 'read', async (args) => {
    const body = ws.get(String(args.path));
    if (body === undefined) return `File not found: ${String(args.path)}`;
    const count = body.split('\n').length;
    return `[lines 1–${count} of ${count}]\n${body}`;
  });
  const grep = tool('grep', 'read', async (args) => {
    const pattern = new RegExp(String(args.pattern));
    const rows: string[] = [];
    for (const [path, body] of ws) {
      body.split('\n').forEach((line, n) => {
        if (pattern.test(line)) rows.push(`${path}:${n + 1}:${line.trim()}`);
      });
    }
    return rows.join('\n') || `(no matches for ${String(args.pattern)})`;
  });
  const edit = tool('edit_file', 'mutate', async (args) => {
    const path = String(args.path);
    ws.set(path, `${ws.get(path) ?? ''}\n// edited`);
    return `Patched ${path}`;
  });
  const check = tool('run_terminal', 'exec', async () => 'cwd: /w\nexit 0\nall tests passed', {
    classify: (result) => {
      const exit = /^exit (\d+)$/.exec(result.split('\n', 2)[1] ?? '');
      return exit ? { outcome: 'ok', exitCode: Number(exit[1]) } : { outcome: 'error' };
    },
  });
  const delegate = tool('delegate', 'subagent', async () => report);
  return [read, grep, edit, check, delegate];
}

// ---------------------------------------------------------------- the model

type Behaviour = {
  /** Facts the task needs (FACT-1 … FACT-n). */
  facts: number;
  /** Independent reads/searches per turn. */
  batch: number;
  /** Start with one delegate whose report covers the first `delegated` facts. */
  delegated?: number;
  /** Repeat the first search this many extra times (a model that forgot it searched). */
  repeatSearch?: number;
  /** After gathering: edit these files, re-read them, run a passing check. */
  edit?: string[];
};

const factsIn = (text: string) => [...text.matchAll(/FACT-(\d+)/g)].map((m) => Number(m[1]));

function body(message: ChatCompletionMessageParam): string {
  return typeof message.content === 'string' ? message.content : '';
}

/**
 * A model that reacts to its prompt: it learns where a fact is from a
 * search, reads the file, and before answering re-reads every fact that is
 * no longer in view (the parent re-verifying in the smoke run). It never
 * re-reads a fact twice at verify time, so runs end.
 */
function reactiveModel(behaviour: Behaviour): ModelCallFn {
  let calls = 0;
  const seen = new Set<number>();
  const located = new Map<number, string>();
  const verified = new Set<number>();
  let repeats = behaviour.repeatSearch ?? 0;
  const edits = behaviour.edit ?? [];
  let editStage = edits.length > 0 ? 0 : 3;
  let delegatePending = (behaviour.delegated ?? 0) > 0;
  return async (_model, messages) => {
    calls += 1;
    const visible = new Set<number>();
    for (const message of messages as ChatCompletionMessageParam[]) {
      if (message.role !== 'tool') continue;
      const text = body(message);
      if (text.startsWith('(evicted)')) continue;
      for (const fact of factsIn(text)) visible.add(fact);
      for (const m of text.matchAll(/(src\/f\d+\.ts):\d+:.*anchor fact-(\d+)/g)) located.set(Number(m[2]), m[1]!);
    }
    for (const fact of visible) seen.add(fact);
    const prompt = Math.ceil(JSON.stringify(messages).length / 4);
    const turn = (toolCalls: PendingToolCall[]): ModelTurn => ({
      content: '',
      toolCalls,
      finishReason: 'tool_calls',
      usage: { promptTokens: prompt, completionTokens: 30 },
    });
    const call = (name: string, args: Record<string, unknown>): PendingToolCall => ({
      id: `c${calls}-${name}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'function',
      function: { name, arguments: JSON.stringify(args) },
    });

    if (delegatePending) {
      delegatePending = false;
      return turn([call('delegate', { profile: 'explore', objective: 'find facts', scope: 'src' })]);
    }
    if (repeats > 0) {
      repeats -= 1;
      return turn([call('grep', { pattern: 'anchor fact-1\\b' })]);
    }
    const missing = Array.from({ length: behaviour.facts }, (_, i) => i + 1).filter((fact) => !seen.has(fact));
    if (missing.length > 0) {
      const next = missing.slice(0, behaviour.batch);
      return turn(
        next.map((fact) =>
          located.has(fact)
            ? call('read_file', { path: located.get(fact) })
            : call('grep', { pattern: `anchor fact-${fact}\\b` }),
        ),
      );
    }
    if (editStage < 3) {
      editStage += 1;
      if (editStage === 1) return turn(edits.map((path) => call('edit_file', { path })));
      if (editStage === 2) return turn(edits.map((path) => call('read_file', { path })));
      return turn([call('run_terminal', { command: 'npm test' })]);
    }
    const stale = Array.from({ length: behaviour.facts }, (_, i) => i + 1).filter(
      (fact) => !visible.has(fact) && !verified.has(fact) && located.has(fact),
    );
    if (stale.length > 0) {
      const next = stale.slice(0, behaviour.batch);
      for (const fact of next) verified.add(fact);
      return turn(next.map((fact) => call('read_file', { path: located.get(fact) })));
    }
    return { content: 'All facts found.', toolCalls: [], finishReason: 'stop', usage: { promptTokens: prompt, completionTokens: 30 } };
  };
}

// ---------------------------------------------------------------- running

type Sim = { trace: TraceEvent[]; steps: number };

async function simulate(
  behaviour: Behaviour,
  ws: Workspace,
  config: Partial<RunLoopConfig> = {},
): Promise<Sim> {
  const trace: TraceEvent[] = [];
  const report = Array.from({ length: behaviour.delegated ?? 0 }, (_, i) => `- FACT-${i + 1} in src/f${i + 1}.ts:7`)
    .join('\n')
    .padEnd(6_000, ' ');
  await runLoop(reactiveModel(behaviour), [{ role: 'user', content: 'collect the facts' }], createToolRegistry(tools(ws, report)), {
    model: 'sim',
    mode: 'workspace',
    runId: 'sim-run',
    limits: { maxIterations: 120, toolTimeoutMs: 5_000, maxPromptTokens: 50_000_000 },
    trace: (event) => trace.push(event),
    putBlob: async () => 'a'.repeat(64),
    ...config,
  });
  return { trace, steps: trace.filter((event) => event.type === 'llm_response').length };
}

const of = <T extends TraceEvent['type']>(sim: Sim, type: T) =>
  sim.trace.filter((event): event is Extract<TraceEvent, { type: T }> => event.type === type);

/** Shapes the invariants are measured on (a small matrix of model behaviours). */
const SHAPES = {
  /** Research over many mid-size files, two reads per turn. */
  research: () => simulate({ facts: 16, batch: 2 }, workspace(16, 20_000)),
  /** Many small files read one at a time: cold results, not the cap. */
  serial: () => simulate({ facts: 14, batch: 1 }, workspace(14, 8_000)),
  /** A delegate report first, then the parent's own reads. */
  delegated: () => simulate({ facts: 12, batch: 2, delegated: 6 }, workspace(12, 20_000)),
  /** A search the model repeats. */
  repeat: () => simulate({ facts: 3, batch: 1, repeatSearch: 4 }, workspace(3, 4_000)),
  /** Gather, edit, re-read the edited file, pass a check. */
  change: () => simulate({ facts: 6, batch: 2, edit: ['src/f1.ts'] }, workspace(6, 20_000)),
  /** Two large files still in view, both edited and re-read: the old reads are superseded. */
  rework: () => simulate({ facts: 2, batch: 2, edit: ['src/f1.ts', 'src/f2.ts'] }, workspace(2, 30_000)),
};
type ShapeName = keyof typeof SHAPES;
const runs = new Map<ShapeName, Promise<Sim>>();
const run = (name: ShapeName) => {
  if (!runs.has(name)) runs.set(name, SHAPES[name]());
  return runs.get(name)!;
};

/** Read results that returned a line range already returned, with no edit of that file between. */
function sameRangeReReads(sim: Sim): number {
  const args = new Map<string, string>();
  for (const start of of(sim, 'tool_start')) {
    if (start.toolName === 'read_file' || start.toolName === 'edit_file') {
      args.set(start.toolCallId ?? '', `${start.toolName}\u0000${String((start.args as { path?: unknown }).path)}`);
    }
  }
  const seen = new Map<string, Set<string>>();
  let repeats = 0;
  for (const done of of(sim, 'tool_complete')) {
    const [name, path] = (args.get(done.toolCallId ?? '') ?? '').split('\u0000');
    if (!name || !path) continue;
    if (name === 'edit_file') {
      seen.delete(path);
      continue;
    }
    const range = /^\[lines (\d+)–(\d+)/.exec(done.resultPreview ?? '');
    if (!range) continue;
    const key = `${range[1]}-${range[2]}`;
    const ranges = seen.get(path) ?? new Set<string>();
    if (ranges.has(key)) repeats += 1;
    ranges.add(key);
    seen.set(path, ranges);
  }
  return repeats;
}

// ---------------------------------------------------------------- invariants

/** I1: outside a boundary, at most one removal pass per this many steps. */
const REMOVAL_EVERY_STEPS = 4;
/** I2: residue (cards + old call arguments) stays under this share of the prompt. */
const RESIDUE_MAX_SHARE = 0.25;
/** I3: per step, the prompt grows by at most the new content plus this many tokens. */
const GROWTH_SLACK_TOKENS = 600;

describe('harness invariants over a reacting model', () => {
  it('the simulated runs finish and actually exercise the harness', async () => {
    for (const name of Object.keys(SHAPES) as ShapeName[]) {
      const sim = await run(name);
      expect(of(sim, 'run_finish')[0]?.status, name).toBe('completed');
      expect(of(sim, 'context_shape').length, name).toBe(sim.steps);
    }
    expect(of(await run('research'), 'context_evicted').length).toBeGreaterThan(0);
  });

  // Phase 2 (priced working set): removal only at boundaries, to a low mark.
  it.fails('I1: removals happen at boundaries, not every step', async () => {
    const sim = await run('research');
    const removalSteps = new Set(of(sim, 'context_evicted').map((event) => event.iteration)).size;
    expect(removalSteps).toBeLessThanOrEqual(Math.ceil(sim.steps / REMOVAL_EVERY_STEPS));
  });

  it('I2: residue stays a bounded share of the prompt', async () => {
    for (const name of ['research', 'serial', 'delegated'] as ShapeName[]) {
      const last = of(await run(name), 'context_shape').at(-1)!;
      expect(last.residueTokens / last.promptTokens, name).toBeLessThanOrEqual(RESIDUE_MAX_SHARE);
    }
  });

  it('I3: a step adds no more to the prompt than its new content', async () => {
    for (const name of Object.keys(SHAPES) as ShapeName[]) {
      const sim = await run(name);
      const shapes = of(sim, 'context_shape');
      for (let i = 1; i < shapes.length; i++) {
        const before = shapes[i - 1]!;
        const after = shapes[i]!;
        const added = of(sim, 'tool_complete')
          .filter((event) => event.iteration === before.iteration)
          .reduce((sum, event) => sum + Math.ceil((event.resultChars ?? 0) / 4), 0);
        expect(after.promptTokens - before.promptTokens, `${name} step ${after.iteration}`).toBeLessThanOrEqual(
          added + GROWTH_SLACK_TOKENS,
        );
      }
    }
  });

  it('I4: a child run stays inside its allocation', async () => {
    const allocation = childAllocation({
      profile: { maxToolCalls: 450, maxIterations: 200, maxPromptTokens: 2_500_000 },
      thoroughness: 'quick',
      parentRemaining: 10_000_000,
    })!;
    // A model that never stops searching: only the limits end it.
    const sim = await simulate({ facts: 60, batch: 3 }, workspace(60, 8_000), {
      limits: {
        maxIterations: allocation.maxIterations,
        maxToolCalls: allocation.maxToolCalls,
        maxPromptTokens: allocation.maxPromptTokens,
        toolTimeoutMs: 5_000,
      },
    });
    const finish = of(sim, 'run_finish')[0]!;
    const lastCall = of(sim, 'llm_response').at(-1)?.usage?.promptTokens ?? 0;
    expect(finish.toolCalls).toBeLessThanOrEqual(allocation.maxToolCalls);
    // The budget is checked before a call, so one call can cross it.
    expect(finish.usage?.own.promptTokens ?? 0).toBeLessThanOrEqual(allocation.maxPromptTokens + lastCall);
  });

  // Phase 2 (priced working set) and phase 4 (reports join the record).
  it.fails('I5: a sub-agent report is never removed to save tokens', async () => {
    const sim = await run('delegated');
    const reportIds = new Set(of(sim, 'tool_start').filter((event) => event.toolName === 'delegate').map((event) => event.toolCallId));
    const removed = of(sim, 'context_evicted').flatMap((event) => event.toolCallIds ?? []);
    expect(removed.filter((id) => reportIds.has(id))).toEqual([]);
  });

  // Phase 2 (restores from sha) and phase 3 (findings recorded, not re-read).
  it.fails('I6: an unchanged range is never charged a fresh model step', async () => {
    expect(sameRangeReReads(await run('research'))).toBe(0);
  });

  it('I6 holds where nothing was removed (the measure itself is sound)', async () => {
    const sim = await simulate({ facts: 3, batch: 3 }, workspace(3, 2_000));
    expect(of(sim, 'context_evicted')).toHaveLength(0);
    expect(sameRangeReReads(sim)).toBe(0);
  });

  /** Mechanisms that must each fire on at least one shape. */
  const REACHABLE = [
    'context_evicted:budget',
    'context_evicted:cold',
    'context_evicted:superseded',
    'context_compacted_inrun:milestone',
    'policy_decision:guard',
  ];

  it('I7: every mechanism fires on at least one shape', async () => {
    const fired = new Set<string>();
    for (const name of Object.keys(SHAPES) as ShapeName[]) {
      for (const event of (await run(name)).trace) {
        if (event.type === 'context_evicted') fired.add(`context_evicted:${event.reason ?? 'none'}`);
        if (event.type === 'context_compacted_inrun') fired.add(`context_compacted_inrun:${event.reason ?? 'size'}`);
        if (event.type === 'policy_decision') fired.add(`policy_decision:${event.kind}`);
      }
    }
    expect(REACHABLE.filter((mechanism) => !fired.has(mechanism))).toEqual([]);
  });

  // Phase 2: the size-triggered in-run compaction sits above where the
  // resident cap and residue level off, so it never fires (dead code).
  it.fails('I7: size-triggered in-run compaction is reachable', async () => {
    const fired = new Set<string>();
    for (const name of Object.keys(SHAPES) as ShapeName[]) {
      for (const event of (await run(name)).trace) {
        if (event.type === 'context_compacted_inrun' && event.reason !== 'milestone') fired.add('size');
      }
    }
    expect(fired.has('size')).toBe(true);
  });

  it('uses the real context budget (results here are the shipped behaviour)', () => {
    expect(DEFAULT_CONTEXT_BUDGET.inRunResidentToolTokens).toBeGreaterThan(0);
  });
});

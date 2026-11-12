/**
 * Replay: scripted model runs whose trace lines, emitted events and durable
 * ledger rows are compared with file snapshots in `__replay__/`. A change to
 * loop.ts that alters any of them fails here; update the snapshots with
 * `vitest -u` only when the change is the point, and review their diff.
 */
import { describe, expect, it } from 'vitest';
import {
  ChoiceSkipped,
  DEFAULT_CONTEXT_BUDGET,
  type AgentEventWithoutSeq,
  type LedgerRecord,
  type ModelTurn,
  type PendingToolCall,
  type TraceEvent,
} from '@agent/agent-models';

import { runLoop } from './loop';
import { createToolRegistry } from '../tools/registry';
import { offer_choice } from '../tools/offer-choice';
import type { Tool } from '../tools/types';
import type { ModelCallFn, RunLoopConfig } from './types';

function tool(name: string, stage: Tool['stage'], execute: Tool['execute']): Tool {
  return {
    definition: { type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } },
    guidance: { whenToUse: ['test'], whenNotToUse: ['never'], usage: ['call'] },
    stage,
    execute,
  };
}

const read = tool('read_file', 'read', async (args) => `contents of ${String(args.path)}`);
const bigRead = tool('read_file', 'read', async (args) => `${String(args.path)}:\n${'x'.repeat(4_000)}`);
const edit = tool('edit_file', 'mutate', async (args) => `Patched ${String(args.path)}`);
/** A check that passes, classified like the real run_terminal (exit code from line 2). */
const passingCheck: Tool = {
  ...tool('run_terminal', 'exec', async () => 'cwd: /w\nexit 0\nall tests passed'),
  classify: (result) => {
    const exit = /^exit (\d+)$/.exec(result.split('\n', 2)[1] ?? '');
    return exit ? { outcome: 'ok', exitCode: Number(exit[1]) } : { outcome: 'error' };
  },
};

function call(id: string, name: string, args: Record<string, unknown> = {}): PendingToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function turn(toolCalls: PendingToolCall[], promptTokens = 1_000): ModelTurn {
  return { content: '', toolCalls, finishReason: 'tool_calls', usage: { promptTokens, completionTokens: 20 } };
}

function answer(content: string, promptTokens = 1_000): ModelTurn {
  return { content, toolCalls: [], finishReason: 'stop', usage: { promptTokens, completionTokens: 20 } };
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Drop what changes between runs (time, durations, random ids) so the snapshot is the behaviour. */
function normalise(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, field) => {
      if (key === 'ts' || key === 'startedAt' || key === 'finishedAt') return undefined;
      if (key === 'durationMs' || key === 'runDurationMs' || key === 'latencyMs') return 0;
      if (typeof field === 'string') return field.replace(UUID, '<id>');
      return field;
    }),
  );
}

async function replay(
  script: (call: number) => ModelTurn,
  tools: Tool[],
  config: Partial<RunLoopConfig> = {},
): Promise<unknown> {
  const trace: TraceEvent[] = [];
  const events: AgentEventWithoutSeq[] = [];
  const ledger: LedgerRecord[] = [];
  // Exactly what each model call saw, so a change to prompt order or nudge text fails too.
  const prompts: unknown[] = [];
  let calls = 0;
  const modelCall: ModelCallFn = async (_model, messages) => {
    prompts.push(structuredClone(messages));
    return script(++calls);
  };
  let result: unknown;
  try {
    result = await runLoop(modelCall, [{ role: 'user', content: 'do the task' }], createToolRegistry(tools), {
      model: 'replay',
      mode: 'workspace',
      runId: 'replay-run',
      limits: { maxIterations: 12, toolTimeoutMs: 5_000 },
      trace: (event) => trace.push(event),
      emit: (event) => events.push(event),
      onMessage: (record) => {
        ledger.push(record);
      },
      ...config,
    });
  } catch (error) {
    result = { threw: error instanceof Error ? error.message : String(error) };
  }
  return normalise({ result, trace, events, ledger, prompts });
}

describe('loop replay', () => {
  it('plain answer', async () => {
    const out = await replay(() => answer('All done.'), []);
    await expect(JSON.stringify(out, null, 2)).toMatchFileSnapshot('./__replay__/plain-answer.json');
  });

  it('parallel reads, then an edit, then an answer', async () => {
    const out = await replay(
      (n) =>
        n === 1
          ? turn([call('r1', 'read_file', { path: 'a.ts' }), call('r2', 'read_file', { path: 'b.ts' })])
          : n === 2
            ? turn([call('e1', 'edit_file', { path: 'a.ts' })])
            : answer('Edited a.ts.'),
      [read, edit],
    );
    await expect(JSON.stringify(out, null, 2)).toMatchFileSnapshot('./__replay__/reads-then-edit.json');
  });

  it('token limit stop with its handoff', async () => {
    const out = await replay(
      (n) => (n <= 3 ? turn([call(`r${n}`, 'read_file', { path: `f${n}.ts` })], 4_000) : answer('Handoff: read f1–f3.', 4_000)),
      [read],
      { limits: { maxIterations: 12, maxPromptTokens: 10_000, toolTimeoutMs: 5_000 } },
    );
    await expect(JSON.stringify(out, null, 2)).toMatchFileSnapshot('./__replay__/token-limit.json');
  });

  it('milestone checkpoint after edits pass a check', async () => {
    const out = await replay(
      (n) =>
        n <= 3
          ? turn([call(`r${n}`, 'read_file', { path: `f${n}.ts` })])
          : n === 4
            ? turn([call('e1', 'edit_file', { path: 'f1.ts' })])
            : n === 5
              ? turn([call('t1', 'run_terminal', { command: 'npm test' })])
              : answer('Changed f1.ts; npm test passes.'),
      [bigRead, edit, passingCheck],
      {
        contextBudget: {
          ...DEFAULT_CONTEXT_BUDGET,
          // Small marks so this short run's own context counts as large.
          inRunClearAtLeastTokens: 300,
          inRunKeepToolResults: 1,
        },
      },
    );
    await expect(JSON.stringify(out, null, 2)).toMatchFileSnapshot('./__replay__/milestone.json');
  });

  it('eviction of old tool results', async () => {
    const out = await replay(
      (n) => (n <= 4 ? turn([call(`r${n}`, 'read_file', { path: `big${n}.ts` })]) : answer('Read them all.')),
      [bigRead],
      {
        contextBudget: {
          ...DEFAULT_CONTEXT_BUDGET,
          // Four ~1k-token reads against a 1.5k-token resident cap: the
          // least recently touched go to cards at once.
          inRunResidentToolTokens: 1_500,
          inRunKeepToolResults: 1,
          inRunClearAtLeastTokens: 500,
        },
      },
    );
    await expect(JSON.stringify(out, null, 2)).toMatchFileSnapshot('./__replay__/eviction.json');
  });

  it('cancel in the middle of a batch', async () => {
    const controller = new AbortController();
    const cancelling = tool('edit_file', 'mutate', async (args) => {
      controller.abort();
      return `Patched ${String(args.path)}`;
    });
    const out = await replay(
      (n) => (n === 1 ? turn([call('e1', 'edit_file', { path: 'a.ts' }), call('e2', 'edit_file', { path: 'b.ts' })]) : answer('unreachable')),
      [cancelling],
      { signal: controller.signal },
    );
    await expect(JSON.stringify(out, null, 2)).toMatchFileSnapshot('./__replay__/cancel-mid-batch.json');
  });

  it('skipped choice ends with a summary', async () => {
    const out = await replay(
      (n) =>
        n === 1
          ? turn([
              call('c1', 'offer_choice', {
                question: 'Which approach?',
                options: [
                  { id: 'a', label: 'Approach A' },
                  { id: 'b', label: 'Approach B' },
                ],
              }),
              call('s1', 'later', {}),
            ])
          : answer('Open question: A or B. I recommend A.'),
      [offer_choice, tool('later', 'subagent', async () => 'ran')],
      {
        offerChoice: async () => {
          throw new ChoiceSkipped();
        },
      },
    );
    await expect(JSON.stringify(out, null, 2)).toMatchFileSnapshot('./__replay__/choice-skipped.json');
  });
});

import { describe, expect, it } from 'vitest';

import type { TraceLine } from '../read/trace.js';
import { computeHealth } from './health.js';

const runId = 'r';
let id = 0;

function step(iteration: number, tools: { name: string; args?: Record<string, unknown>; preview?: string; exitCode?: number }[], effort = 'high'): TraceLine[] {
  const lines: TraceLine[] = [
    { type: 'llm_request', runId, iteration, reasoningEffort: effort },
    { type: 'llm_response', runId, iteration, hasToolCalls: tools.length > 0, usage: { promptTokens: 1_000, completionTokens: 10 } } as TraceLine,
  ];
  for (const tool of tools) {
    const toolCallId = `t${++id}`;
    lines.push({ type: 'tool_start', runId, iteration, toolName: tool.name, toolCallId, args: tool.args ?? {} } as TraceLine);
    lines.push({
      type: 'tool_complete',
      runId,
      iteration,
      toolName: tool.name,
      toolCallId,
      durationMs: 0,
      resultPreview: tool.preview ?? 'ok',
      ...(tool.exitCode !== undefined ? { exitCode: tool.exitCode, outcome: 'ok' } : {}),
    } as TraceLine);
  }
  return lines;
}

const read = (path: string, from = 1, to = 50, of = 50) => ({ name: 'read_file', args: { path }, preview: `[lines ${from}–${to} of ${of}]\nbody` });

describe('harness health', () => {
  it('counts same-range re-reads, and an edit of the file resets them', () => {
    const lines = [
      ...step(1, [read('a.ts'), read('b.ts')]),
      ...step(2, [read('a.ts')]),
      ...step(3, [{ name: 'edit_file', args: { path: 'a.ts' }, preview: 'Patched a.ts' }]),
      ...step(4, [read('a.ts')]),
    ];
    const health = computeHealth(lines, 4_000);
    expect(health.reReads).toEqual({ reads: 4, sameRange: 1, rate: 0.25 });
  });

  it('counts removal steps, residue share and prefix stability from the new events', () => {
    const lines = [
      ...step(1, [read('a.ts')]),
      ...step(2, [read('b.ts')]),
      { type: 'context_evicted', runId, iteration: 2, evicted: 1, beforeTokens: 10, afterTokens: 5, reason: 'budget' } as TraceLine,
      { type: 'context_shape', runId, iteration: 1, messages: 4, promptTokens: 1_000, residentToolTokens: 500, residueTokens: 100, prefixStableMessages: 0 } as TraceLine,
      { type: 'context_shape', runId, iteration: 2, messages: 6, promptTokens: 1_000, residentToolTokens: 400, residueTokens: 300, prefixStableMessages: 2 } as TraceLine,
    ];
    const health = computeHealth(lines, 2_000);
    expect(health.removalSteps).toBe(1);
    expect(health.removalStepShare).toBe(0.5);
    expect(health.residueShare).toEqual({ mean: 0.2, last: 0.3 });
    // The second call kept 2 of the first call's 4 messages.
    expect(health.prefixStability).toBe(0.5);
  });

  it('scores advice by whether its behaviour followed, once per first showing', () => {
    const lines = [
      ...step(1, [read('a.ts')]),
      { type: 'policy_decision', runId, iteration: 2, kind: 'card', ids: ['advice:serial_reads', 'open:unchecked'] } as TraceLine,
      ...step(2, [read('b.ts'), read('c.ts')]),
      { type: 'policy_decision', runId, iteration: 3, kind: 'card', ids: ['advice:serial_reads', 'open:unchecked'] } as TraceLine,
      ...step(3, [read('d.ts')]),
    ];
    const health = computeHealth(lines, 3_000);
    expect(health.advice.shown).toBe(2);
    expect(health.advice.byKind['advice:serial_reads']).toEqual({ shown: 1, followed: 1 });
    // No check ran after the unchecked-edit item appeared.
    expect(health.advice.byKind['open:unchecked']).toEqual({ shown: 1, followed: 0 });
  });

  it('counts a recorded finding as following stall advice and the unrecorded-reads item', () => {
    const finding = { name: 'record_finding', args: { claim: 'c', evidence: 'a.ts:1' }, preview: 'Recorded finding 1.' };
    const lines = [
      ...step(1, [read('a.ts')]),
      { type: 'policy_decision', runId, iteration: 2, kind: 'card', ids: ['advice:stall', 'open:unrecorded'] } as TraceLine,
      ...step(2, [finding]),
    ];
    const health = computeHealth(lines, 2_000);
    expect(health.advice.byKind['advice:stall']).toEqual({ shown: 1, followed: 1 });
    expect(health.advice.byKind['open:unrecorded']).toEqual({ shown: 1, followed: 1 });

    const ignored = [
      ...step(1, [read('a.ts')]),
      { type: 'policy_decision', runId, iteration: 2, kind: 'card', ids: ['open:unrecorded'] } as TraceLine,
      ...step(2, [read('b.ts')]),
    ];
    expect(computeHealth(ignored, 2_000).advice.byKind['open:unrecorded']).toEqual({ shown: 1, followed: 0 });
  });

  it('scores the re-read item by whether the named files are restored again or recorded', () => {
    const restored = (iteration: number, path: string) =>
      ({ type: 'context_restored', runId, iteration, toolCallId: `x${++id}`, path }) as TraceLine;
    const card = { type: 'policy_decision', runId, iteration: 3, kind: 'card', ids: ['open:reread'] } as TraceLine;
    const base = [...step(1, [read('a.ts')]), ...step(2, [read('a.ts')]), restored(2, 'a.ts'), card];

    // Restored again in the window, nothing recorded: not followed.
    const again = [...base, ...step(3, [read('a.ts')]), restored(3, 'a.ts')];
    expect(computeHealth(again, 3_000).advice.byKind['open:reread']).toEqual({ shown: 1, followed: 0 });

    // A finding cites it (even with another restore): followed.
    const finding = { name: 'record_finding', args: { claim: 'c', evidence: 'a.ts:1' }, preview: 'Recorded (verified) — evidence: a.ts:1' };
    const cited = [...base, ...step(3, [read('a.ts'), finding]), restored(3, 'a.ts')];
    expect(computeHealth(cited, 3_000).advice.byKind['open:reread']).toEqual({ shown: 1, followed: 1 });

    // No further restore of it: followed.
    const quiet = [...base, ...step(3, [read('b.ts')])];
    expect(computeHealth(quiet, 3_000).advice.byKind['open:reread']).toEqual({ shown: 1, followed: 1 });
  });

  it('flags low-effort steps that make no progress; searches alone are not progress', () => {
    const lines = [
      ...step(1, [read('a.ts')], 'none'),
      ...step(2, [{ name: 'grep', args: { pattern: 'x' } }], 'none'),
      ...step(3, [{ name: 'grep', args: { pattern: 'y' } }], 'high'),
      ...step(4, [{ name: 'grep', args: { pattern: 'x' } }], 'none'),
    ];
    const health = computeHealth(lines, 4_000);
    expect(health.repeatSearches).toEqual({ searches: 3, repeats: 1, rate: 1 / 3 });
    expect(health.effortVsProgress).toEqual({ lowEffortSteps: 3, stepsWithoutProgress: 3, lowEffortWithoutProgress: 2 });
  });

  it('counts evidence (edits, passing checks after edits) and checks a child against its budget', () => {
    const lines = [
      { type: 'child_budget', runId, parentRunId: 'p', profile: 'explore', maxToolCalls: 3, maxIterations: 4, maxPromptTokens: 2_500 } as TraceLine,
      ...step(1, [{ name: 'edit_file', args: { path: 'a.ts' }, preview: 'Patched a.ts' }]),
      ...step(2, [{ name: 'run_terminal', args: { command: 'npm test' }, exitCode: 0 }]),
      { type: 'run_finish', runId, iterations: 2, toolCalls: 2, status: 'completed', usage: { own: { promptTokens: 2_000, completionTokens: 20, calls: 2, estimatedCalls: 0 }, children: { promptTokens: 0, completionTokens: 0, calls: 0, estimatedCalls: 0 } } } as TraceLine,
    ];
    const health = computeHealth(lines, 2_000);
    expect(health.evidence).toBe(2);
    expect(health.costPerEvidence).toBe(1_000);
    expect(health.childBudget).toMatchObject({ spentPromptTokens: 2_000, toolCalls: 2, within: true });
  });
});

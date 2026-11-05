import { describe, expect, it } from 'vitest';

import { summarizeRun } from '../read/runs.js';
import { parseTrace, type TraceLine } from '../read/trace.js';
import { areaRows, signalsOf } from './areas.js';
import { computeRunMetrics } from './run-metrics.js';
import { summarizeMetrics } from './thread-metrics.js';

/** A small enforce-mode run as the JSONL sink writes it. */
const SYSTEM1_TRACE: TraceLine[] = [
  { seq: 1, type: 'run_start', runId: 'r1', model: 'm' },
  { seq: 2, type: 'system1_decision', runId: 'r1', iteration: 1, decision: { mode: 'enforce', baseline: 'high', chosen: 'low', applied: true, reason: 'lower', latencyMs: 120 } },
  { seq: 3, type: 'llm_request', runId: 'r1', iteration: 1, reasoningEffort: 'low' },
  { seq: 4, type: 'llm_response', runId: 'r1', iteration: 1, finishReason: 'tool_calls', hasToolCalls: true, usage: { promptTokens: 1000, completionTokens: 10, totalTokens: 1010 } },
  { seq: 5, type: 'memory_gate', runId: 'r1', toolName: 'memory', target: 'notes', verdict: 'reject', why: 'secret' },
  { seq: 6, type: 'skill_loaded', runId: 'r1', name: 'nx', tokens: 800, source: 'model' },
  { seq: 7, type: 'system1_decision', runId: 'r1', iteration: 2, decision: { mode: 'enforce', baseline: 'high', chosen: 'high', applied: false, reason: 'timeout' } },
  { seq: 8, type: 'llm_request', runId: 'r1', iteration: 2, reasoningEffort: 'high' },
  { seq: 9, type: 'llm_response', runId: 'r1', iteration: 2, finishReason: 'stop', hasToolCalls: false, usage: { promptTokens: 1200, completionTokens: 20, totalTokens: 1220 } },
  { seq: 10, type: 'context_prefix_heavy', runId: 'r1', iteration: 2, promptTokens: 1200 },
  {
    seq: 11,
    type: 'system1_report',
    runId: 'r1',
    report: {
      mode: 'enforce',
      calls: 2,
      applied: 1,
      fallbacks: [{ site: 'effort', kind: 'timeout', count: 1, firstIteration: 2, detail: 'timed out' }],
      latencyMs: { p50: 120, p95: 5000 },
    },
  },
  { seq: 12, type: 'run_finish', runId: 'r1', iterations: 2, toolCalls: 0, status: 'completed' },
];

function metricsOf(lines: TraceLine[]) {
  const parsed = parseTrace(lines.map((line) => JSON.stringify(line)).join('\n')).lines;
  const run = summarizeRun({ runId: 'r1', threadId: 't1', tracePath: 'r1.jsonl', lines: parsed, warnings: 0 });
  return computeRunMetrics({ run, lines: parsed });
}

describe('computeRunMetrics', () => {
  it('summarises System 1 from its decision and report lines', () => {
    expect(metricsOf(SYSTEM1_TRACE).system1).toEqual({
      mode: 'enforce',
      calls: 2,
      decisions: 2,
      applied: 1,
      changed: 1,
      transitions: { 'high→low': 1, 'high→high': 1 },
      fallbacks: { timeout: 1 },
      latencyMs: { p50: 120, p95: 5000 },
    });
  });

  it('counts memory gate verdicts, skills and prefix-heavy passes', () => {
    const m = metricsOf(SYSTEM1_TRACE);
    expect(m.memoryGate).toEqual({ reject: 1 });
    expect(m.skills).toEqual({ loaded: 1, loadedTokens: 800, evicted: 0 });
    expect(m.steering.prefixHeavy).toBe(1);
    expect(m.reasoningEffort).toEqual({ low: 1, high: 1 });
  });

  it('reports System 1 as off when the trace has no System 1 lines', () => {
    const plain = SYSTEM1_TRACE.filter((line) => !line.type.startsWith('system1_'));
    expect(metricsOf(plain).system1).toBeNull();
  });

  it('counts shadow decisions that would have changed the call', () => {
    const shadow = SYSTEM1_TRACE.filter((line) => line.type !== 'system1_report').map((line) =>
      line.type === 'system1_decision' ? { ...line, decision: { ...line.decision, mode: 'shadow' as const, applied: false } } : line,
    );
    const s1 = metricsOf(shadow).system1!;
    expect(s1).toMatchObject({ mode: 'shadow', calls: null, applied: 0, changed: 1, latencyMs: { p50: 120, p95: 120 } });
  });

  it('computes phases, call shape, growth, time, tool outcomes and verification', () => {
    const lines: TraceLine[] = [
      { seq: 1, type: 'run_start', runId: 'r1', model: 'm', layers: [{ id: 'system', label: 'System', tokens: 2000 }, { id: 'conversation', label: 'Conversation', tokens: 6000 }] },
      { seq: 2, type: 'llm_request', runId: 'r1', iteration: 1 },
      { seq: 3, type: 'llm_response', runId: 'r1', iteration: 1, finishReason: 'tool_calls', hasToolCalls: true, durationMs: 1000, usage: { promptTokens: 1000, completionTokens: 1 } },
      { seq: 4, type: 'tool_start', runId: 'r1', iteration: 1, toolName: 'read_file', toolCallId: 'a', stage: 'read', args: {} },
      { seq: 5, type: 'tool_complete', runId: 'r1', iteration: 1, toolName: 'read_file', toolCallId: 'a', durationMs: 500, resultPreview: 'x' },
      { seq: 6, type: 'llm_request', runId: 'r1', iteration: 2 },
      { seq: 7, type: 'llm_response', runId: 'r1', iteration: 2, finishReason: 'tool_calls', hasToolCalls: true, durationMs: 1000, usage: { promptTokens: 2000, completionTokens: 1 } },
      { seq: 8, type: 'tool_start', runId: 'r1', iteration: 2, toolName: 'edit_file', toolCallId: 'b', stage: 'mutate', args: {} },
      { seq: 9, type: 'tool_complete', runId: 'r1', iteration: 2, toolName: 'edit_file', toolCallId: 'b', durationMs: 100, resultPreview: 'oldText span not found', outcome: 'error' },
      { seq: 10, type: 'tool_start', runId: 'r1', iteration: 2, toolName: 'edit_file', toolCallId: 'c', stage: 'mutate', args: {} },
      { seq: 11, type: 'tool_complete', runId: 'r1', iteration: 2, toolName: 'edit_file', toolCallId: 'c', durationMs: 100, resultPreview: 'Patched a.ts', outcome: 'ok' },
      { seq: 12, type: 'llm_request', runId: 'r1', iteration: 3 },
      { seq: 13, type: 'llm_response', runId: 'r1', iteration: 3, finishReason: 'tool_calls', hasToolCalls: true, durationMs: 1000, usage: { promptTokens: 6000, completionTokens: 1 } },
      { seq: 14, type: 'tool_start', runId: 'r1', iteration: 3, toolName: 'todo', toolCallId: 'd', stage: 'mutate', args: {} },
      { seq: 15, type: 'tool_complete', runId: 'r1', iteration: 3, toolName: 'todo', toolCallId: 'd', durationMs: 10, resultPreview: 'ok' },
      { seq: 16, type: 'llm_request', runId: 'r1', iteration: 4 },
      { seq: 17, type: 'llm_response', runId: 'r1', iteration: 4, finishReason: 'stop', hasToolCalls: false, durationMs: 1000, usage: { promptTokens: 6500, completionTokens: 1 } },
      { seq: 18, type: 'run_finish', runId: 'r1', iterations: 4, toolCalls: 4, status: 'completed' },
    ];
    const m = metricsOf(lines);
    expect(m.edits).toBe(1);
    expect(m.phases).toEqual({ beforeFirstEdit: 3000, editing: 0, afterLastEdit: 12500 });
    expect(m.callShape).toEqual({ answer: 1, single: 2, multi: 1, planOnly: 1 });
    expect(m.promptGrowth).toBe(6);
    expect(m.firstCallLayers).toEqual({ system: 2000, conversation: 6000 });
    expect(m.time).toEqual({ modelMs: 4000, toolSeconds: 0.7 });
    expect(m.toolOutcomes.edit_file).toEqual({ calls: 2, errors: 1, nonZeroExit: 0 });
    expect(m.toolsByStage).toEqual({ read: 1, mutate: 3 });
    expect(m.verifiedAfterEdit).toBe(false);
    expect(m.untracedPromptTokens).toBe(0);

    const fired = signalsOf(m).map((s) => `${s.area}:${s.signal}:${s.severity}`);
    expect(fired).toContain('tools:failed edits:warn');
    expect(fired).toContain('verification:edits never checked by a command:warn');
    expect(fired).toContain('context:prompt growth (last ÷ first call):warn');
    expect(fired).toContain('batching:plan-only iterations:warn');
  });

  it('reads stage and edit outcome from old traces without the new fields', () => {
    const m = metricsOf([
      { seq: 1, type: 'run_start', runId: 'r1', model: 'm' },
      { seq: 2, type: 'llm_request', runId: 'r1', iteration: 1 },
      { seq: 3, type: 'llm_response', runId: 'r1', iteration: 1, finishReason: 'tool_calls', hasToolCalls: true },
      { seq: 4, type: 'tool_start', runId: 'r1', iteration: 1, toolName: 'report', args: {} },
      { seq: 5, type: 'tool_start', runId: 'r1', iteration: 1, toolName: 'edit_file', args: {} },
      { seq: 6, type: 'tool_complete', runId: 'r1', iteration: 1, toolName: 'edit_file', durationMs: 1, resultPreview: 'Created b.ts' },
      { seq: 7, type: 'run_finish', runId: 'r1', iterations: 1, toolCalls: 2, status: 'completed' },
    ]);
    expect(m.toolsByStage).toEqual({ read: 1, mutate: 1 });
    expect(m.edits).toBe(1);
  });

  it('ranks areas by the tokens of the runs that trip them', () => {
    const rows = areaRows([metricsOf(SYSTEM1_TRACE)]);
    expect(rows.find((row) => row.area === 'system1')).toMatchObject({ runs: 1, worst: { signal: 'System 1 fallback rate', severity: 'bad' } }); // 1 fallback in 2 decisions
  });

  it('aggregates System 1 across runs', () => {
    const summary = summarizeMetrics([metricsOf(SYSTEM1_TRACE), metricsOf(SYSTEM1_TRACE.slice(0, 1))]);
    expect(summary.system1).toEqual({ runs: 1, modes: { enforce: 1 }, decisions: 2, applied: 1, changed: 1, fallbacks: 1 });
    expect(summary.memoryGate).toEqual({ reject: 1 });
  });
});

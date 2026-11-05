import { describe, expect, it } from 'vitest';

import { summarizeRun } from '../read/runs.js';
import { parseTrace, type TraceLine } from '../read/trace.js';
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

  it('aggregates System 1 across runs', () => {
    const summary = summarizeMetrics([metricsOf(SYSTEM1_TRACE), metricsOf(SYSTEM1_TRACE.slice(0, 1))]);
    expect(summary.system1).toEqual({ runs: 1, modes: { enforce: 1 }, decisions: 2, applied: 1, changed: 1, fallbacks: 1 });
    expect(summary.memoryGate).toEqual({ reject: 1 });
  });
});

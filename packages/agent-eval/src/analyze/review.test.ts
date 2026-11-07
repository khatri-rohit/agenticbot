import {
  emptyThreadPlan,
  parseThreadReview,
  sameReviewFingerprint,
  type LedgerEnvelope,
} from '@agent/agent-models';
import { describe, expect, it } from 'vitest';

import { computeRunMetrics } from '../metrics/run-metrics.js';
import { summarizeRun } from '../read/runs.js';
import { parseTrace, type TraceLine } from '../read/trace.js';
import {
  analyzeThreadFrom,
  buildReviewInput,
  reviewFingerprint,
} from './review.js';

function envelopes(messages: Array<{ role: 'user' | 'assistant'; content: string }>): LedgerEnvelope[] {
  return messages.map((message, i) => ({
    v: 1 as const,
    seq: i + 1,
    ts: '2026-11-07T00:00:00.000Z',
    threadId: 't1',
    runId: 'r1',
    record: { role: message.role, content: message.content },
  }));
}

function metricsOf(lines: TraceLine[]) {
  const parsed = parseTrace(lines.map((line) => JSON.stringify(line)).join('\n')).lines;
  const run = summarizeRun({
    runId: 'r1',
    threadId: 't1',
    tracePath: 'r1.jsonl',
    lines: parsed,
    warnings: 0,
  });
  return computeRunMetrics({ run, lines: parsed });
}

function answerRun(): ReturnType<typeof metricsOf> {
  return metricsOf([
    { seq: 1, type: 'run_start', runId: 'r1', model: 'm' },
    { seq: 2, type: 'llm_request', runId: 'r1', iteration: 1, final: true },
    {
      seq: 3,
      type: 'llm_response',
      runId: 'r1',
      iteration: 1,
      finishReason: 'stop',
      hasToolCalls: false,
      usage: { promptTokens: 800, completionTokens: 40, totalTokens: 840 },
    },
    { seq: 4, type: 'run_finish', runId: 'r1', iterations: 1, toolCalls: 0, status: 'completed' },
  ]);
}

function editRun(toolOutcome: 'ok' | 'error' = 'ok'): ReturnType<typeof metricsOf> {
  return metricsOf([
    { seq: 1, type: 'run_start', runId: 'r1', model: 'm' },
    { seq: 2, type: 'llm_request', runId: 'r1', iteration: 1 },
    {
      seq: 3,
      type: 'llm_response',
      runId: 'r1',
      iteration: 1,
      finishReason: 'tool_calls',
      hasToolCalls: true,
      usage: { promptTokens: 1200, completionTokens: 20, totalTokens: 1220 },
    },
    { seq: 4, type: 'tool_start', runId: 'r1', iteration: 1, toolName: 'edit_file', args: { path: 'a.ts' } },
    {
      seq: 5,
      type: 'tool_complete',
      runId: 'r1',
      iteration: 1,
      toolName: 'edit_file',
      durationMs: 10,
      resultPreview: toolOutcome === 'ok' ? 'Patched a.ts' : 'oldText not found',
      outcome: toolOutcome,
    },
    { seq: 6, type: 'run_finish', runId: 'r1', iterations: 1, toolCalls: 1, status: 'completed' },
  ]);
}

function serialReads(count: number): ReturnType<typeof metricsOf> {
  const lines: TraceLine[] = [{ seq: 1, type: 'run_start', runId: 'r1', model: 'm' }];
  let seq = 1;
  for (let i = 1; i <= count; i += 1) {
    lines.push({ seq: ++seq, type: 'llm_request', runId: 'r1', iteration: i });
    lines.push({
      seq: ++seq,
      type: 'llm_response',
      runId: 'r1',
      iteration: i,
      finishReason: 'tool_calls',
      hasToolCalls: true,
      usage: { promptTokens: 1000 * i, completionTokens: 10, totalTokens: 1000 * i + 10 },
    });
    lines.push({
      seq: ++seq,
      type: 'tool_start',
      runId: 'r1',
      iteration: i,
      toolName: 'read_file',
      args: { path: 'a.ts', limit: 10 },
    });
    lines.push({
      seq: ++seq,
      type: 'tool_complete',
      runId: 'r1',
      iteration: i,
      toolName: 'read_file',
      durationMs: 5,
      resultPreview: 'ok',
      outcome: 'ok',
    });
  }
  lines.push({
    seq: ++seq,
    type: 'run_finish',
    runId: 'r1',
    iterations: count,
    toolCalls: count,
    status: 'completed',
  });
  return metricsOf(lines);
}

describe('reviewFingerprint', () => {
  it('changes when the ledger grows', () => {
    const runs = [{ runId: 'r1', status: 'completed' }];
    const first = reviewFingerprint({ threadId: 't1', ledger: envelopes([{ role: 'user', content: 'hi' }]), runs });
    const next = reviewFingerprint({
      threadId: 't1',
      ledger: envelopes([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]),
      runs,
    });
    expect(sameReviewFingerprint(first, next)).toBe(false);
    expect(first.ledgerLength).toBe(1);
    expect(next.ledgerLength).toBe(2);
  });

  it('is stable across run order', () => {
    const ledger = envelopes([{ role: 'user', content: 'hi' }]);
    const a = reviewFingerprint({
      threadId: 't1',
      ledger,
      runs: [
        { runId: 'b', status: 'completed' },
        { runId: 'a', status: 'error' },
      ],
    });
    const b = reviewFingerprint({
      threadId: 't1',
      ledger,
      runs: [
        { runId: 'a', status: 'error' },
        { runId: 'b', status: 'completed' },
      ],
    });
    expect(sameReviewFingerprint(a, b)).toBe(true);
  });
});

describe('analyzeThreadFrom', () => {
  it('marks a short completed answer as aligned and good', () => {
    const metrics = answerRun();
    const { digest } = analyzeThreadFrom({
      threadId: 't1',
      title: 'Math',
      plan: emptyThreadPlan('t1'),
      ledger: envelopes([
        { role: 'user', content: 'What is 2+2?' },
        { role: 'assistant', content: '4' },
      ]),
      runs: [{ ...metrics, children: [], tracePath: 'r1.jsonl', depth: 0, traceWarnings: 0 }],
      metrics: [metrics],
    });
    expect(digest.alignment.verdict).toBe('aligned');
    expect(digest.findings.some((finding) => finding.kind === 'good')).toBe(true);
    expect(digest.numbers.runs).toBe(1);
    expect(digest.numbers.edits).toBe(0);
  });

  it('flags edits on a question as misread intent', () => {
    const metrics = editRun();
    const { digest } = analyzeThreadFrom({
      threadId: 't1',
      title: 'Ask',
      plan: emptyThreadPlan('t1'),
      ledger: envelopes([{ role: 'user', content: 'What does this function do?' }]),
      runs: [{ ...metrics, children: [], tracePath: 'r1.jsonl', depth: 0, traceWarnings: 0 }],
      metrics: [metrics],
    });
    expect(digest.alignment.verdict).toBe('diverged');
    expect(digest.findings.some((finding) => finding.kind === 'misread-intent')).toBe(true);
  });

  it('flags a change request with no edits as misread intent', () => {
    const metrics = answerRun();
    const { digest } = analyzeThreadFrom({
      threadId: 't1',
      title: 'Fix',
      plan: emptyThreadPlan('t1'),
      ledger: envelopes([{ role: 'user', content: 'Fix the crash in login.ts' }]),
      runs: [{ ...metrics, children: [], tracePath: 'r1.jsonl', depth: 0, traceWarnings: 0 }],
      metrics: [metrics],
    });
    expect(digest.alignment.verdict).toBe('diverged');
    expect(digest.alignment.note).toMatch(/no applied edits/i);
  });

  it('flags serial single-tool reads as unnecessary calls and over-work', () => {
    const metrics = serialReads(5);
    const { digest, excerpts } = analyzeThreadFrom({
      threadId: 't1',
      title: 'Reads',
      plan: emptyThreadPlan('t1'),
      ledger: envelopes([{ role: 'user', content: 'Fix the bug in a.ts' }]),
      runs: [{ ...metrics, children: [], tracePath: 'r1.jsonl', depth: 0, traceWarnings: 0 }],
      metrics: [metrics],
    });
    expect(digest.findings.some((finding) => finding.kind === 'unnecessary-calls')).toBe(true);
    expect(digest.numbers.readWalks).toBeGreaterThanOrEqual(1);
    expect(digest.numbers.oneToolShare).toBeGreaterThan(0.5);
    const input = buildReviewInput(digest, excerpts);
    expect(input.excerpts.length).toBeGreaterThan(0);
    expect(input.excerpts.length).toBeLessThanOrEqual(5);
  });

  it('records failed edits as waste', () => {
    const metrics = editRun('error');
    const { digest } = analyzeThreadFrom({
      threadId: 't1',
      title: 'Patch',
      plan: emptyThreadPlan('t1'),
      ledger: envelopes([{ role: 'user', content: 'Fix a.ts' }]),
      runs: [{ ...metrics, children: [], tracePath: 'r1.jsonl', depth: 0, traceWarnings: 0 }],
      metrics: [metrics],
    });
    expect(digest.numbers.failedEdits).toBe(1);
    expect(digest.findings.some((finding) => finding.kind === 'waste')).toBe(true);
  });

  it('caps excerpts at five', () => {
    const metrics = answerRun();
    const extras = Array.from({ length: 8 }, (_, i) => ({ source: `e${i}`, text: `excerpt ${i}` }));
    const { digest, excerpts } = analyzeThreadFrom({
      threadId: 't1',
      title: 'Math',
      plan: emptyThreadPlan('t1'),
      ledger: envelopes([{ role: 'user', content: 'What is 2+2?' }]),
      runs: [{ ...metrics, children: [], tracePath: 'r1.jsonl', depth: 0, traceWarnings: 0 }],
      metrics: [metrics],
    });
    expect(buildReviewInput(digest, [...excerpts, ...extras]).excerpts).toHaveLength(5);
  });

  it('round-trips a stored artifact through parseThreadReview', () => {
    const metrics = answerRun();
    const { fingerprint, digest } = analyzeThreadFrom({
      threadId: 't1',
      title: 'Math',
      plan: emptyThreadPlan('t1'),
      ledger: envelopes([{ role: 'user', content: 'What is 2+2?' }]),
      runs: [{ ...metrics, children: [], tracePath: 'r1.jsonl', depth: 0, traceWarnings: 0 }],
      metrics: [metrics],
    });
    const stored = parseThreadReview({
      threadId: 't1',
      fingerprint,
      createdAt: '2026-11-07T00:00:00.000Z',
      digest,
      narrative: null,
    });
    expect(stored?.digest.alignment.verdict).toBe('aligned');
    expect(parseThreadReview({ threadId: 't1' })).toBeNull();
  });
});

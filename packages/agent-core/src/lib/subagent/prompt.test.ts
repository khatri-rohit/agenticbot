import { describe, expect, it } from 'vitest';

import { REPORT_MAX_CHARS, type SubagentReport } from '@agent/agent-models';

import { createReportTool, renderDigest, renderReport } from './prompt';
import { DIGEST_MAX_CHARS, UNTRUSTED_SUBAGENT_BEGIN, UNTRUSTED_SUBAGENT_END } from './types';

const ctx = { runId: 'r', threadId: 't', origin: 'eval' as const, signal: new AbortController().signal };

function report(findings: number, claimChars: number) {
  return {
    status: 'done',
    summary: 'Summary.',
    findings: Array.from({ length: findings }, (_, i) => ({ claim: `${i}:${'c'.repeat(claimChars)}`, evidence: `src/f${i}.ts:1` })),
  };
}

describe('report size bound', () => {
  it('admits a report within the limit', () => {
    const tool = createReportTool(() => undefined);
    expect(tool.admit?.(report(5, 50), ctx)).toBeNull();
  });

  it('sends an over-long report back once to be shortened, then takes it', () => {
    const tool = createReportTool(() => undefined);
    const long = report(100, 120);
    expect(renderReport(long as SubagentReport).length).toBeGreaterThan(REPORT_MAX_CHARS);
    expect(tool.admit?.(long, ctx)).toMatch(/^Report not recorded: it is [\d,]+ characters and the limit is 8,000/);
    // A second over-long attempt is taken; the digest then points at the full text.
    expect(tool.admit?.(long, ctx)).toBeNull();
  });

  it('leaves malformed reports to execute, which explains the error', () => {
    const tool = createReportTool(() => undefined);
    expect(tool.admit?.({ summary: 'no status' }, ctx)).toBeNull();
  });
});

const SHA = 'a'.repeat(64);

/** The digest body between the untrusted markers. */
function inner(digest: string): string {
  return digest.slice(UNTRUSTED_SUBAGENT_BEGIN.length + 1, -(UNTRUSTED_SUBAGENT_END.length + 1));
}

describe('bounded digest', () => {
  const long = {
    ...report(100, 120),
    status: 'partial',
    issues: [{ location: 'src/x.ts:9', problem: 'off by one' }],
    openQuestions: ['where is b configured', 'is c still used'],
  } as SubagentReport;

  it('passes a report within the bound through whole', () => {
    const small = report(3, 20) as SubagentReport;
    expect(inner(renderDigest(small, SHA))).toBe(renderReport(small));
  });

  it('stays within the bound with the run-status prefix counted inside', () => {
    const prefix = 'Run incomplete (limit.tools: max tool calls exceeded (31)).\n';
    const body = inner(renderDigest(long, SHA, prefix));
    expect(body.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(body.startsWith(`${prefix}Status: partial\n\nSummary.`)).toBe(true);
    expect(body).not.toContain('…(cut');
  });

  it('keeps the gaps when findings overflow, and names what is left in the full report', () => {
    const body = inner(renderDigest(long, SHA));
    expect(body.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    expect(body).toContain('Open questions:\n- where is b configured\n- is c still used');
    // Findings in order from the first; the issue and the tail overflow.
    expect(body).toContain('- 0:');
    expect(body).not.toContain('src/x.ts:9');
    const shown = body.split('\n').filter((line) => /^- \d+:/.test(line)).length;
    expect(shown).toBeGreaterThan(0);
    expect(body).toContain(
      `(${101 - shown} more findings and issues in the full report: recall sha256:${SHA})`,
    );
  });

  it('cuts an unstructured body at a line boundary, with the recall pointer inside the bound', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`);
    const body = inner(renderDigest(lines.join('\n'), SHA, 'Run incomplete (limit.tools).\n'));
    expect(body.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS);
    const [last, marker] = body.split('\n').slice(-2);
    expect(marker).toBe(`…(cut; full report: recall sha256:${SHA})`);
    expect(lines).toContain(last);
  });
});

/**
 * I8 (v2 build plan): one value per quantity. Where two parts of the
 * harness mean the same thing, they must agree, or a bug like the 7k read
 * window cut again by a 16k live cap, or a "~150 calls" brief running under
 * a 450-call limit, comes back. Each check names the pair it guards.
 */
import { describe, expect, it } from 'vitest';

import {
  CHARS_PER_TOKEN,
  CHILD_BUDGET_SHARE,
  childAllocation,
  DEFAULT_CONTEXT_BUDGET,
  FINDING_CLAIM_MAX_CHARS,
  FINDING_EVIDENCE_MAX_CHARS,
  FINDINGS_MAX,
  GREP_WINDOW,
  liveResultCapChars,
  MAX_CONCURRENT_SUBAGENTS,
  READ_WINDOW,
  RECORD_CARD_MAX_CHARS,
  REPORT_MAX_CHARS,
  THOROUGHNESS_TOOL_CALLS,
  type SubagentThoroughness,
} from '@agent/agent-models';

import { createDelegateTool } from './subagent/delegate';
import { getSubagentProfile, listSubagentProfiles } from './subagent/profiles';
import { buildBrief, createReportTool } from './subagent/prompt';
import { DIGEST_MAX_CHARS } from './subagent/types';
import { record_finding } from './tools/record-finding';
import {
  WORKSPACE_GREP_MAX_CHARS,
  WORKSPACE_GREP_MAX_CONTEXT,
  WORKSPACE_READ_MAX_CHARS,
  WORKSPACE_READ_MAX_LINES,
  WORKSPACE_READ_MIN_LINES,
} from './tools/workspace/tools';

const LEVELS = Object.keys(THOROUGHNESS_TOOL_CALLS) as SubagentThoroughness[];

describe('I8: one value per quantity', () => {
  it('workspace tools use the limits module windows', () => {
    expect(WORKSPACE_READ_MAX_CHARS).toBe(READ_WINDOW.maxChars);
    expect(WORKSPACE_READ_MAX_LINES).toBe(READ_WINDOW.maxLines);
    expect(WORKSPACE_READ_MIN_LINES).toBe(READ_WINDOW.minLines);
    expect(WORKSPACE_GREP_MAX_CHARS).toBe(GREP_WINDOW.maxChars);
    expect(WORKSPACE_GREP_MAX_CONTEXT).toBe(GREP_WINDOW.maxContext);
  });

  it('the live cap never cuts a result its tool already sized', () => {
    const generic = DEFAULT_CONTEXT_BUDGET.toolResultMaxTokens * CHARS_PER_TOKEN;
    expect(liveResultCapChars('read_file', generic)).toBeGreaterThanOrEqual(READ_WINDOW.maxChars);
    expect(liveResultCapChars('grep', generic)).toBeGreaterThanOrEqual(GREP_WINDOW.maxChars);
  });

  it('one whole read window fits under the resident cap, and a removal pass frees less than the cap', () => {
    expect(READ_WINDOW.maxChars / CHARS_PER_TOKEN).toBeLessThanOrEqual(DEFAULT_CONTEXT_BUDGET.inRunResidentToolTokens);
    expect(DEFAULT_CONTEXT_BUDGET.inRunClearAtLeastTokens).toBeLessThan(DEFAULT_CONTEXT_BUDGET.inRunResidentToolTokens);
  });

  it('the digest the parent reads holds the whole report the child is told to write', () => {
    expect(DIGEST_MAX_CHARS).toBe(REPORT_MAX_CHARS);
    const description = createReportTool(() => undefined).definition.function.description ?? '';
    expect(description).toContain(REPORT_MAX_CHARS.toLocaleString('en-US'));
  });

  it('the effort a brief names is the limit the child runs under', () => {
    const explore = getSubagentProfile('explore')!;
    expect(explore.defaultThoroughness).toBeDefined();
    for (const level of LEVELS) {
      const calls = THOROUGHNESS_TOOL_CALLS[level];
      const brief = buildBrief({ profile: 'explore', objective: 'o', scope: 's', thoroughness: level });
      expect(brief).toContain(`up to ${calls} tool calls`);
      const allocation = childAllocation({ profile: explore.limits, thoroughness: level })!;
      // One call is kept for the closing report.
      expect(allocation.maxToolCalls).toBe(calls + 1);
      expect(allocation.maxToolCalls).toBeLessThanOrEqual(explore.limits.maxToolCalls);
      expect(allocation.maxPromptTokens).toBeLessThanOrEqual(explore.limits.maxPromptTokens);
    }
  });

  it('the delegate tool states the same effort budgets and concurrency', () => {
    const delegate = createDelegateTool(listSubagentProfiles());
    const text = JSON.stringify(delegate.definition);
    for (const level of LEVELS) expect(text).toContain(`${level} (${THOROUGHNESS_TOOL_CALLS[level]} tool calls)`);
    expect(text).toContain(`at most ${MAX_CONCURRENT_SUBAGENTS} at a time`);
  });

  it('record_finding states the same size limits the task state applies, and the card can show a full record', () => {
    const text = JSON.stringify(record_finding.definition);
    expect(text).toContain(`max ${FINDING_CLAIM_MAX_CHARS} chars`);
    expect(text).toContain(`max ${FINDING_EVIDENCE_MAX_CHARS} chars`);
    // A typical finding (~120 chars) fits the card for the whole record.
    expect(FINDINGS_MAX * 120).toBeLessThanOrEqual(RECORD_CARD_MAX_CHARS);
  });

  it('the residue fold and the resident low mark sit inside their caps', () => {
    expect(DEFAULT_CONTEXT_BUDGET.inRunResidentLowRatio).toBeGreaterThan(0);
    expect(DEFAULT_CONTEXT_BUDGET.inRunResidentLowRatio).toBeLessThan(1);
    // Folding must start well before the size mark would.
    const input = DEFAULT_CONTEXT_BUDGET.windowTokens - DEFAULT_CONTEXT_BUDGET.outputReserveTokens;
    expect(DEFAULT_CONTEXT_BUDGET.inRunResidueFoldTokens).toBeLessThan(input * DEFAULT_CONTEXT_BUDGET.inRunCompactRatio);
  });

  it('parallel children can never be promised more than the parent has left', () => {
    const parentRemaining = 1_000_000;
    let promised = 0;
    for (let i = 0; i < MAX_CONCURRENT_SUBAGENTS; i++) {
      const allocation = childAllocation({
        profile: { maxToolCalls: 450, maxIterations: 200, maxPromptTokens: 10_000_000 },
        parentRemaining,
        promised,
      })!;
      expect(allocation.maxPromptTokens).toBeLessThanOrEqual((parentRemaining - promised) * CHILD_BUDGET_SHARE);
      promised += allocation.maxPromptTokens;
    }
    expect(promised).toBeLessThan(parentRemaining);
    expect(childAllocation({ profile: { maxToolCalls: 1, maxIterations: 1, maxPromptTokens: 1 }, parentRemaining: 10, promised: 10 })).toBeNull();
  });
});

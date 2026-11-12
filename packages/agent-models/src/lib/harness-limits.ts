import type { SubagentThoroughness } from './subagent.js';

/**
 * Harness limits: tool result windows, sub-agent budgets and report size.
 * One home per quantity. Where two places mean the same thing (a read
 * window and the live cap that must not cut it again; the report a child
 * writes and the digest the parent reads; the effort a brief names and the
 * limit the child runs under), one is derived from the other here, and
 * harness-limits.test.ts checks they agree.
 *
 * In-run context knobs (resident cap, cold window, compaction marks) are
 * scaled per model window and live in context.ts (ContextBudget); the
 * consistency test covers them too.
 */

/**
 * read_file window. Sized against the cost of a model call, not of one
 * result: at a ~36k-token prompt, a 40k-char read that saves one follow-up
 * call pays for itself several times over.
 */
export const READ_WINDOW = {
  maxChars: 40_000,
  maxLines: 2_000,
  /** A window into a larger file is never smaller than this. */
  minLines: 200,
  /** Files larger than this are not loaded at all. */
  maxLoadBytes: 1_000_000,
} as const;

export const GREP_WINDOW = {
  maxMatches: 100,
  /** Room for context lines; a cut search sends the model back for another. */
  maxChars: 12_000,
  lineMaxChars: 200,
  /** Upper bound for `context`; wider windows are what read_file is for. */
  maxContext: 5,
} as const;

export const GLOB_MAX_RESULTS = 200;
export const WALK_MAX_FILES = 2_000;

export const TERMINAL_WINDOW = { maxChars: 8_000, timeoutMs: 120_000 } as const;
export const DIFF_MAX_CHARS = 12_000;

/** Header and note slack a tool adds around its own window. */
const READ_HEADER_SLACK_CHARS = 1_000;
const GREP_HEADER_SLACK_CHARS = 500;

/**
 * Largest result the live prompt keeps for a tool that sizes its own output.
 * The generic live cap must not cut a result again after the tool already
 * chose its window.
 */
export function liveResultCapChars(toolName: string | undefined, fallback: number): number {
  if (toolName === 'read_file') return Math.max(fallback, READ_WINDOW.maxChars + READ_HEADER_SLACK_CHARS);
  if (toolName === 'grep') return Math.max(fallback, GREP_WINDOW.maxChars + GREP_HEADER_SLACK_CHARS);
  return fallback;
}

/**
 * Findings a run keeps (record_finding), and the size of each part. The cap
 * is high on purpose: a dropped finding is research the model must redo (a
 * 12-section fact sheet records ~100 facts).
 */
export const FINDINGS_MAX = 200;
export const FINDING_CLAIM_MAX_CHARS = 400;
export const FINDING_EVIDENCE_MAX_CHARS = 200;
/**
 * Characters of findings the harness card shows (~6k tokens), newest first.
 * Typical findings are ~120 characters, so ~200 fit; past it, the oldest
 * are counted, not shown.
 */
export const RECORD_CARD_MAX_CHARS = 24_000;

/**
 * Sub-agent report: the child writes at most this much and the parent's
 * digest shows all of it, so nothing is cut between them (~2k tokens).
 */
export const REPORT_MAX_CHARS = 8_000;

/** Parallel children per parent run. Extra spawns wait for a slot. */
export const MAX_CONCURRENT_SUBAGENTS = 4;

/** Share of the parent's remaining prompt budget (after other children's promises) one child may take. */
export const CHILD_BUDGET_SHARE = 0.25;

/**
 * Tool calls a child may make per effort level. The brief names the same
 * number and the child's run stops there, so the effort is a budget, not a
 * hint.
 */
export const THOROUGHNESS_TOOL_CALLS: Record<SubagentThoroughness, number> = {
  quick: 10,
  medium: 40,
  thorough: 120,
};

/**
 * Prompt tokens a child may spend per tool call it is allowed. A search
 * step re-sends ~30k tokens and makes ~2–3 calls, so this leaves headroom
 * without letting the token cap stand in for the call cap.
 */
export const CHILD_TOKENS_PER_TOOL_CALL = 15_000;

/** Calls beyond the effort budget kept for the closing `report` call. */
const REPORT_CALL_RESERVE = 1;

export type ChildLimits = {
  maxToolCalls: number;
  maxIterations: number;
  maxPromptTokens: number;
};

/**
 * A child's limits: the effort level's budget, never above the profile's
 * own limits, and its prompt tokens never above CHILD_BUDGET_SHARE of what
 * the parent has left after the promises already made to running children.
 * Returns null when the parent has nothing left to share.
 */
export function childAllocation(input: {
  profile: ChildLimits;
  thoroughness?: SubagentThoroughness;
  /** Parent prompt tokens left; undefined when the parent has no token cap. */
  parentRemaining?: number;
  /** Prompt tokens already promised to this parent's running children. */
  promised?: number;
}): ChildLimits | null {
  const { profile, thoroughness } = input;
  let maxToolCalls = profile.maxToolCalls;
  let maxIterations = profile.maxIterations;
  let maxPromptTokens = profile.maxPromptTokens;
  if (thoroughness) {
    const calls = THOROUGHNESS_TOOL_CALLS[thoroughness];
    maxToolCalls = Math.min(maxToolCalls, calls + REPORT_CALL_RESERVE);
    // A step makes at least one call; one more step answers after a limit.
    maxIterations = Math.min(maxIterations, maxToolCalls + 1);
    maxPromptTokens = Math.min(maxPromptTokens, calls * CHILD_TOKENS_PER_TOOL_CALL);
  }
  if (input.parentRemaining !== undefined) {
    const share = Math.floor(
      Math.max(0, input.parentRemaining - (input.promised ?? 0)) * CHILD_BUDGET_SHARE,
    );
    if (share <= 0) return null;
    maxPromptTokens = Math.min(maxPromptTokens, share);
  }
  return { maxToolCalls, maxIterations, maxPromptTokens };
}

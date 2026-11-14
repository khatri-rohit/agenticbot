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
/**
 * Files one glob/grep walk visits (node_modules, .git, dist and the like are
 * skipped). Sized for real monorepos: a walk that stops early makes grep miss
 * matches, and a missed match reads as "not found" — a wrong answer, not a
 * slow one. Both tools say when the walk stopped.
 */
export const WALK_MAX_FILES = 20_000;

/**
 * run_terminal output and time. Output keeps the first `headChars` and the
 * last of `maxChars` (errors and summaries come last). The default timeout
 * covers a typical build or test run; a call can ask for up to
 * `maxTimeoutMs` (long monorepo suites), and servers or watch modes still
 * end instead of hanging the run.
 */
export const TERMINAL_WINDOW = {
  maxChars: 8_000,
  headChars: 2_000,
  timeoutMs: 300_000,
  maxTimeoutMs: 1_800_000,
} as const;
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
 * Findings a run keeps (record_finding), and the size of each part. A
 * finding is the one item in context that cannot be recovered (P4: it is
 * derived, not read), so the cap is a safety bound on memory, not a working
 * limit: a 12-section fact sheet records ~100 facts, and at the part caps
 * 1,000 findings are under 1 MB. What the card cannot show is stored whole
 * as a blob (see ContextBudget.recordCardTokens), so the card's size never
 * limits the record.
 */
export const FINDINGS_MAX = 1_000;
export const FINDING_CLAIM_MAX_CHARS = 400;
export const FINDING_EVIDENCE_MAX_CHARS = 200;

/**
 * Sub-agent report: the child writes at most this much and the parent's
 * digest shows all of it, so nothing is cut between them (~2k tokens).
 */
export const REPORT_MAX_CHARS = 8_000;

/**
 * The user's request a review brief quotes ("the request this work serves").
 * The brief is re-sent on every call of the child, so a long request is cut
 * here; the cut says how much is missing and names the stored full text.
 */
export const BRIEF_USER_REQUEST_MAX_CHARS = 4_000;

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

/**
 * Limits a sub-agent run adds over its profile: a child repeats an identical
 * call at most this often, and one tool call may take this long.
 */
export const CHILD_RUN = {
  maxRepeatedToolCalls: 3,
  toolTimeoutMs: 60_000,
} as const;

/**
 * Policy marks (phase 5): the thresholds the decisions in agent-core's
 * `policy/` read. Each is a property of the task, not of one result.
 */

/**
 * Spend since the last evidence (an edit, a passing check, a recorded
 * finding, a sub-agent report) before the harness steps in. `stall` puts
 * advice on the card; `gate` closes the run's own web research until the
 * next evidence. Each mark is a share of the run's prompt budget, capped in
 * absolute tokens: idle spend is waste at any run size. The `conserve`
 * marks apply while the host says account capacity is behind pace.
 *
 * Stall also needs `stallMinIdleSteps` model steps without evidence: spend
 * alone is not a stall. With a large prompt two calls pass the token mark
 * while the run is still reading what it needs (live run: 160k per call,
 * the 180k mark tripped on the second call). One step more than the effort
 * floor (EFFORT_IDLE_FLOOR_STEPS): effort is held first, advice comes after.
 */
export const PROGRESS_MARKS = {
  stallRatio: 0.3,
  gateRatio: 0.5,
  stallMaxTokens: 750_000,
  gateMaxTokens: 1_250_000,
  stallMinIdleSteps: 4,
  conserve: {
    stallRatio: 0.2,
    gateRatio: 0.35,
    stallMaxTokens: 500_000,
    gateMaxTokens: 875_000,
  },
  /** Turns in a row whose every call hit the gate before the run ends with a handoff. */
  maxGatedTurns: 2,
} as const;

/**
 * Expected prompt spend per task class (P1, P7): the pace a run is measured
 * against, not a stop. Stall advice scales from it, and the card shows it, so
 * a small task hears "act on what you have" sooner than a long one. The hard
 * stop stays the mode's `maxPromptTokens` (the ceiling); a run that grows is
 * promoted by its evidence (TASK_CLASS_MARKS) and gets the larger pace.
 * Sized from live runs: a small edit or question stays well under 600k; the
 * best long research run (12-section fact sheet) took 1.33M with a child.
 */
export const CLASS_PACE_TOKENS = {
  small: 600_000,
  medium: 2_000_000,
  long: 6_000_000,
} as const;

/**
 * Model steps without new evidence after which reasoning effort may not go
 * below the run's baseline (F-4: a run that is not progressing is the run
 * that most needs to think, not the one to save on).
 */
export const EFFORT_IDLE_FLOOR_STEPS = 3;

/** Loop guards: what ends or refuses a run that is going in circles. */
export const GUARD_LIMITS = {
  /** Invented tool names in a row before the run halts. */
  unknownToolStreak: 2,
  /** read_file admits per path per run (stops offset-paging storms). */
  readsPerPath: 30,
  /** run_terminal admits per run (migrations run 40+ builds). */
  terminalCalls: 60,
  /** Identical edit or command outcome (call + result) before the run halts. */
  identicalOutcomes: 3,
  /** Turns of only-refused calls in a report-only child before it ends. */
  reportOnlyTurns: 2,
} as const;

/**
 * Task class marks: a run is promoted (never demoted) as its evidence grows.
 * Steps count for every shape; edits and edited files for a change;
 * recorded findings for research.
 */
export const TASK_CLASS_MARKS = {
  medium: { steps: 12, editedFiles: 3, edits: 4, findings: 20 },
  long: { steps: 40, editedFiles: 8, edits: Number.POSITIVE_INFINITY, findings: 80 },
} as const;

/** Harness card timing: quiet first steps, and serial-read advice. */
export const CARD_MARKS = {
  /** The card is skipped on the first steps of a run unless it has something to say. */
  quietSteps: 2,
  /** Turns in a row whose only call was one read before batching advice. */
  serialReadAdviceAfter: 4,
  /**
   * Findings the card carries since the task record was last written into
   * the prompt history (they are re-sent uncached every call); past this
   * many tokens the record moves into history at a boundary of its own.
   */
  recordDeltaTokens: 1_500,
} as const;

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

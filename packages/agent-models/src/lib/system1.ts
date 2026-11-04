/**
 * System 1: a fast local scorer (POST OLLAMA_SYSTEMONE_URL) that answers
 * yes/no questions about a state text with a score in [0, 1]. The harness
 * uses it as an optional advisor for decisions; it never writes content.
 * Shapes only — the client and policies live in @agent/agent-core.
 */

/** Composer/API sentinel: let System 1 pick the thinking level per iteration. */
export const SYSTEM1_AUTO_THINKING = 'auto';

/** off = never called; shadow = called and traced, never applied; enforce = applied. */
export type System1Mode = 'off' | 'shadow' | 'enforce';

/** Decision points that consult System 1. */
export type System1Site = 'effort';

/** The only question type observed on the endpoint so far. */
export type System1Question = {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
};

export type System1Scores = Record<string, number>;

/**
 * Why a call gave no opinion. `cancelled` and `disabled` are never shown
 * as warnings: a cancelled run and an unset URL are not failures.
 */
export type System1FallbackKind =
  | 'unreachable'
  | 'timeout'
  | 'http_error'
  | 'bad_response'
  | 'inconsistent'
  | 'breaker_open'
  | 'busy'
  | 'budget_exhausted'
  | 'internal';

export type System1Fallback = {
  site: System1Site;
  kind: System1FallbackKind;
  count: number;
  /** Loop iteration of the first occurrence. */
  firstIteration: number;
  /** First error message, truncated. Never contains state text. */
  detail: string;
};

/** End-of-run summary. Sent as `system1.report` when it has fallbacks. */
export type System1RunReport = {
  mode: Exclude<System1Mode, 'off'>;
  /** Requests sent to the endpoint (successful or not). */
  calls: number;
  /** Decisions that changed what was sent to the main model. */
  applied: number;
  fallbacks: System1Fallback[];
  latencyMs: { p50: number; p95: number } | null;
};

/** Trace payload for one effort decision. */
export type System1EffortTrace = {
  mode: Exclude<System1Mode, 'off'>;
  /** Wire value sent without System 1 (user pick or model default). */
  baseline?: string;
  /** Wire value System 1 chose (equals baseline when it kept or fell back). */
  chosen?: string;
  applied: boolean;
  reason: string;
  /** Rung keys → scores, when System 1 answered. */
  scores?: System1Scores;
  /** Lowest rung the rules allowed this iteration. */
  floor?: string;
  latencyMs?: number;
};

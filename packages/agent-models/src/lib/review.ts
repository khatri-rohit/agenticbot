/**
 * Stored run-review artifact. The digest is deterministic; the narrative is
 * one bounded model pass over that digest, never the raw trace.
 */

export const REVIEW_FINDING_KINDS = [
  'over-work',
  'unnecessary-calls',
  'misread-intent',
  'waste',
  'good',
] as const;

export type ReviewFindingKind = (typeof REVIEW_FINDING_KINDS)[number];

export type ReviewAlignmentVerdict =
  | 'aligned'
  | 'partial'
  | 'diverged'
  | 'unknown';

/** Invalidates a stored review when any of these change. */
export type ReviewFingerprint = {
  threadId: string;
  ledgerLength: number;
  lastRecordSha: string;
  runs: { runId: string; status: string }[];
};

export type ReviewFinding = {
  kind: ReviewFindingKind;
  summary: string;
  /** Digest facts this finding cites (counts, tool names, plan lines). */
  evidence: string[];
};

export type ReviewAlignment = {
  verdict: ReviewAlignmentVerdict;
  /** Goal from the plan, else the first user message. */
  userPlan: string;
  note: string;
};

export type ReviewNumbers = {
  runs: number;
  completed: number;
  iterations: number;
  toolCalls: number;
  promptTokens: number;
  completionTokens: number;
  edits: number;
  failedEdits: number;
  oneToolShare: number | null;
  planOnly: number;
  readWalks: number;
  stallNudges: number;
  childPromptShare: number | null;
};

export type ReviewRunGlance = {
  runId: string;
  status: string;
  iterations: number;
  toolCalls: number;
  promptTokens: number;
  /** Per-run, over tool-iterating rounds only; null when fewer than 2 such rounds. */
  promptGrowth?: number | null;
  /** Harness health shares (0–1, null when the trace lacks the event); see agent-eval metrics/health.ts. */
  health?: ReviewRunHealth;
};

/** Which harness mechanism misbehaved in a run, as shares the Review can cite. */
export type ReviewRunHealth = {
  /** Steps on which results were removed from the prompt. */
  removalStepShare: number | null;
  /** Residue (cards + old call arguments) share of the last prompt. */
  residueShare: number | null;
  /** Leading messages unchanged call to call (cache reuse). */
  prefixStability: number | null;
  /** Reads of a line range already returned. */
  reReadRate: number | null;
  /** Identical searches repeated. */
  repeatSearchRate: number | null;
  /** Card items whose asked behaviour followed. */
  adviceFollowRate: number | null;
  /** Sub-agents' share of the run's prompt tokens. */
  childShare: number | null;
  /** Steps at low reasoning effort that made no progress. */
  lowEffortWithoutProgress: number;
};

export type ReviewDigest = {
  threadId: string;
  title: string;
  /** Set when the review was requested from a run page. */
  focusRunId?: string;
  alignment: ReviewAlignment;
  findings: ReviewFinding[];
  suggestions: string[];
  numbers: ReviewNumbers;
  runs: ReviewRunGlance[];
};

export type ReviewNarrative = {
  summary: string;
  alignment: string;
  findings: { kind: ReviewFindingKind; text: string }[];
  suggestions: string[];
};

/** `$AGENT_HOME/reviews/<threadId>.json`. */
export type ThreadReview = {
  threadId: string;
  fingerprint: ReviewFingerprint;
  createdAt: string;
  digest: ReviewDigest;
  narrative: ReviewNarrative | null;
};

export function reviewFingerprintKey(fingerprint: ReviewFingerprint): string {
  const runs = [...fingerprint.runs]
    .sort((a, b) => a.runId.localeCompare(b.runId))
    .map((run) => `${run.runId}:${run.status}`);
  return JSON.stringify({
    threadId: fingerprint.threadId,
    ledgerLength: fingerprint.ledgerLength,
    lastRecordSha: fingerprint.lastRecordSha,
    runs,
  });
}

export function sameReviewFingerprint(
  left: ReviewFingerprint,
  right: ReviewFingerprint,
): boolean {
  return reviewFingerprintKey(left) === reviewFingerprintKey(right);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseFindingKind(value: unknown): ReviewFindingKind | null {
  return typeof value === 'string' &&
    (REVIEW_FINDING_KINDS as readonly string[]).includes(value)
    ? (value as ReviewFindingKind)
    : null;
}

function parseAlignmentVerdict(value: unknown): ReviewAlignmentVerdict | null {
  if (
    value === 'aligned' ||
    value === 'partial' ||
    value === 'diverged' ||
    value === 'unknown'
  ) {
    return value;
  }
  return null;
}

function parseStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
}

function parseFingerprint(value: unknown): ReviewFingerprint | null {
  const rec = asRecord(value);
  if (!rec) return null;
  if (typeof rec.threadId !== 'string' || !rec.threadId) return null;
  if (typeof rec.ledgerLength !== 'number' || !Number.isFinite(rec.ledgerLength)) return null;
  if (typeof rec.lastRecordSha !== 'string') return null;
  if (!Array.isArray(rec.runs)) return null;
  const runs: ReviewFingerprint['runs'] = [];
  for (const item of rec.runs) {
    const run = asRecord(item);
    if (!run || typeof run.runId !== 'string' || typeof run.status !== 'string') return null;
    runs.push({ runId: run.runId, status: run.status });
  }
  return {
    threadId: rec.threadId,
    ledgerLength: rec.ledgerLength,
    lastRecordSha: rec.lastRecordSha,
    runs,
  };
}

function parseFinding(value: unknown): ReviewFinding | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const kind = parseFindingKind(rec.kind);
  if (!kind || typeof rec.summary !== 'string' || !rec.summary.trim()) return null;
  return { kind, summary: rec.summary, evidence: parseStringArray(rec.evidence) };
}

function parseAlignment(value: unknown): ReviewAlignment | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const verdict = parseAlignmentVerdict(rec.verdict);
  if (!verdict || typeof rec.userPlan !== 'string' || typeof rec.note !== 'string') return null;
  return { verdict, userPlan: rec.userPlan, note: rec.note };
}

function parseNumbers(value: unknown): ReviewNumbers | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const num = (key: string): number | null => {
    const n = rec[key];
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  };
  const nullable = (key: string): number | null => {
    const n = rec[key];
    if (n === null) return null;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  };
  const runs = num('runs');
  const completed = num('completed');
  const iterations = num('iterations');
  const toolCalls = num('toolCalls');
  const promptTokens = num('promptTokens');
  const completionTokens = num('completionTokens');
  const edits = num('edits');
  const failedEdits = num('failedEdits');
  const planOnly = num('planOnly');
  const readWalks = num('readWalks');
  const stallNudges = num('stallNudges');
  if (
    runs === null ||
    completed === null ||
    iterations === null ||
    toolCalls === null ||
    promptTokens === null ||
    completionTokens === null ||
    edits === null ||
    failedEdits === null ||
    planOnly === null ||
    readWalks === null ||
    stallNudges === null
  ) {
    return null;
  }
  return {
    runs,
    completed,
    iterations,
    toolCalls,
    promptTokens,
    completionTokens,
    edits,
    failedEdits,
    oneToolShare: nullable('oneToolShare'),
    planOnly,
    readWalks,
    stallNudges,
    childPromptShare: nullable('childPromptShare'),
  };
}

function parseRunGlance(value: unknown): ReviewRunGlance | null {
  const rec = asRecord(value);
  if (!rec) return null;
  if (typeof rec.runId !== 'string' || typeof rec.status !== 'string') return null;
  if (typeof rec.iterations !== 'number' || typeof rec.toolCalls !== 'number') return null;
  if (typeof rec.promptTokens !== 'number') return null;
  const growth =
    typeof rec.promptGrowth === 'number' && Number.isFinite(rec.promptGrowth)
      ? rec.promptGrowth
      : null;
  const health = parseRunHealth(rec.health);
  return {
    runId: rec.runId,
    status: rec.status,
    iterations: rec.iterations,
    toolCalls: rec.toolCalls,
    promptTokens: rec.promptTokens,
    ...(growth === null ? { promptGrowth: null } : { promptGrowth: growth }),
    ...(health ? { health } : {}),
  };
}

function parseRunHealth(value: unknown): ReviewRunHealth | undefined {
  const rec = asRecord(value);
  if (!rec) return undefined;
  const share = (key: string): number | null =>
    typeof rec[key] === 'number' && Number.isFinite(rec[key]) ? (rec[key] as number) : null;
  return {
    removalStepShare: share('removalStepShare'),
    residueShare: share('residueShare'),
    prefixStability: share('prefixStability'),
    reReadRate: share('reReadRate'),
    repeatSearchRate: share('repeatSearchRate'),
    adviceFollowRate: share('adviceFollowRate'),
    childShare: share('childShare'),
    lowEffortWithoutProgress: share('lowEffortWithoutProgress') ?? 0,
  };
}

function parseDigest(value: unknown): ReviewDigest | null {
  const rec = asRecord(value);
  if (!rec) return null;
  if (typeof rec.threadId !== 'string' || typeof rec.title !== 'string') return null;
  const alignment = parseAlignment(rec.alignment);
  const numbers = parseNumbers(rec.numbers);
  if (!alignment || !numbers || !Array.isArray(rec.findings) || !Array.isArray(rec.runs)) return null;
  const findings: ReviewFinding[] = [];
  for (const item of rec.findings) {
    const finding = parseFinding(item);
    if (!finding) return null;
    findings.push(finding);
  }
  const runs: ReviewRunGlance[] = [];
  for (const item of rec.runs) {
    const run = parseRunGlance(item);
    if (!run) return null;
    runs.push(run);
  }
  return {
    threadId: rec.threadId,
    title: rec.title,
    ...(typeof rec.focusRunId === 'string' && rec.focusRunId ? { focusRunId: rec.focusRunId } : {}),
    alignment,
    findings,
    suggestions: parseStringArray(rec.suggestions),
    numbers,
    runs,
  };
}

/** Model JSON. Unknown or extra keys are dropped; a bad payload is null. */
export function parseReviewNarrative(raw: unknown): ReviewNarrative | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  if (typeof rec.summary !== 'string' || !rec.summary.trim()) return null;
  if (typeof rec.alignment !== 'string') return null;
  if (!Array.isArray(rec.findings)) return null;
  const findings: ReviewNarrative['findings'] = [];
  for (const item of rec.findings) {
    const row = asRecord(item);
    const kind = row ? parseFindingKind(row.kind) : null;
    if (!row || !kind || typeof row.text !== 'string' || !row.text.trim()) return null;
    findings.push({ kind, text: row.text });
  }
  return {
    summary: rec.summary.trim(),
    alignment: rec.alignment,
    findings,
    suggestions: parseStringArray(rec.suggestions),
  };
}

/** Reconstruct a stored review. Corrupt files are null, not a guess. */
export function parseThreadReview(raw: unknown): ThreadReview | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  if (typeof rec.threadId !== 'string' || !rec.threadId) return null;
  if (typeof rec.createdAt !== 'string' || !rec.createdAt) return null;
  const fingerprint = parseFingerprint(rec.fingerprint);
  const digest = parseDigest(rec.digest);
  if (!fingerprint || !digest) return null;
  const narrative =
    rec.narrative === null ? null : parseReviewNarrative(rec.narrative);
  if (rec.narrative !== null && narrative === null) return null;
  return {
    threadId: rec.threadId,
    fingerprint,
    createdAt: rec.createdAt,
    digest,
    narrative,
  };
}

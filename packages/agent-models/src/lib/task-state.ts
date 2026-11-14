/**
 * Task state: where a run is in its work, reduced from loop events by the
 * harness (never asked of the model). One object every control can read
 * instead of re-deriving its own proxy from raw events.
 *
 * Phases:
 * - orient  — before the first workspace step (reading the request, planning)
 * - locate  — finding and reading the code or sources the change needs
 * - change  — editing; reads in between stay here while edits are unverified
 * - record  — recording findings (research evidence; reads in between
 *             go back to locate)
 * - verify  — a command or review after an edit
 * - report  — the model answered without tool calls
 * - blocked — a limit stopped the run
 */
export type TaskPhase = 'orient' | 'locate' | 'change' | 'record' | 'verify' | 'report' | 'blocked';

export type WorkingSetEntry = {
  path: string;
  reads: number;
  /** Lines the last read returned (from its `[lines a–b of N]` header). */
  lastRange?: { from: number; to: number; of: number };
  lastReadIteration?: number;
  edits: number;
  failedEdits: number;
  lastEditIteration?: number;
};

export type TaskCommand = {
  command: string;
  /** Absent when the command did not run (blocked, timed out without a code). */
  exitCode?: number;
  iteration: number;
  /** Ran while a successful edit had no check after it. */
  afterEdit: boolean;
  /** A project check (build, typecheck, test, lint, compile); only these verify edits. */
  check: boolean;
};

export type TaskEvidence = {
  edits: number;
  failedEdits: number;
  /** Most recent last; capped (see TASK_STATE_COMMANDS_MAX). */
  commands: TaskCommand[];
  toolErrors: number;
  /** Iteration of the first successful edit not yet followed by a check that ran; null when none. */
  unverifiedSince: number | null;
  /** Files edited since the last check that ran. */
  uncheckedFiles: string[];
  /** The latest check that ran. */
  lastCheck: TaskCommand | null;
  /** A delegate(review) was started this run. */
  reviewed: boolean;
  /** Facts recorded this run, oldest first (bounded by FINDINGS_MAX, a memory safety cap, not a working limit). */
  findings: TaskFinding[];
  /**
   * Iteration of the latest evidence of any type (a successful edit, a
   * check that passes after edits or after a failure, a new or upgraded
   * finding, a sub-agent report); 0 before any. Stall and the effort floor
   * count from here.
   */
  lastEvidenceIteration: number;
};

/**
 * Size of the task, from evidence as it grows (never guessed up front):
 * steps for every shape, edits and edited files for a change, recorded
 * findings for research (marks in harness-limits TASK_CLASS_MARKS). Only
 * ever promoted within a run.
 */
export type TaskClass = 'small' | 'medium' | 'long';

/**
 * What the task asks for, which decides what counts as evidence: `change`
 * (edits, then a passing check), `research` (recorded findings about the
 * workspace), `answer` (a reply, no workspace), or `unknown` (no evidence
 * yet). Never guessed from the request's words: the start value comes from
 * the run's setup (no workspace → `answer`; read-only posture → `research`;
 * agent posture in a workspace → `unknown`), and evidence corrects it: an
 * edit makes it `change` (always wins), a recorded finding makes it
 * `research` unless it is already `change`.
 */
export type TaskShape = 'change' | 'research' | 'answer' | 'unknown';

/** One fact the model recorded with record_finding. */
export type TaskFinding = {
  claim: string;
  /** path:line, a URL, or a quoted string (as the tool recorded it, corrected when it was off). */
  evidence: string;
  topic?: string;
  iteration: number;
  /**
   * What record_finding checked against the workspace: `verified` (quoted
   * text at the cited lines, or the cited lines exist), `corrected` (the
   * quote was elsewhere in the cited file; the evidence now names where),
   * `unverified` (quote not found, file missing or lines past its end),
   * `skipped` (URL or no workspace). Every finding is recorded either way.
   */
  verification: 'verified' | 'corrected' | 'unverified' | 'skipped';
  /** Set when the finding came from a sub-agent: its subRunId. Absent = recorded by this run. */
  source?: string;
};

export type TaskStateSnapshot = {
  phase: TaskPhase;
  /** Iteration of the latest model call. */
  iteration: number;
  taskClass: TaskClass;
  shape: TaskShape;
  workingSet: WorkingSetEntry[];
  evidence: TaskEvidence;
  /** Model calls made while in each phase. */
  phaseIterations: Partial<Record<TaskPhase, number>>;
  /**
   * Open questions sub-agents reported (their gaps), newest last: what this
   * run still has to check, instead of re-verifying what they found.
   */
  childGaps: string[];
};

export const TASK_STATE_COMMANDS_MAX = 20;

/**
 * What one finished run leaves for the next runs of its thread: its findings
 * (its own and those merged from sub-agents) and the gaps it left open. The
 * host stores one per run; the next run gets them in its stable prompt
 * prefix (phase 6), so research is not redone on the next turn and
 * compaction of the conversation never loses a recorded fact. A rewind that
 * cuts a run drops its record.
 */
export type RunTaskRecord = {
  runId: string;
  finishedAt: string;
  findings: TaskFinding[];
  /** Open questions (sub-agent gaps) the run did not close. */
  openQuestions: string[];
};

const VERIFICATIONS: ReadonlyArray<TaskFinding['verification']> = ['verified', 'corrected', 'unverified', 'skipped'];

function parseFinding(raw: unknown): TaskFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.claim !== 'string' || typeof value.evidence !== 'string') return null;
  const verification = VERIFICATIONS.includes(value.verification as TaskFinding['verification'])
    ? (value.verification as TaskFinding['verification'])
    : 'skipped';
  return {
    claim: value.claim,
    evidence: value.evidence,
    ...(typeof value.topic === 'string' ? { topic: value.topic } : {}),
    iteration: typeof value.iteration === 'number' ? value.iteration : 0,
    verification,
    ...(typeof value.source === 'string' ? { source: value.source } : {}),
  };
}

/** Stored run records, oldest first; malformed entries are dropped. */
export function parseRunTaskRecords(raw: unknown): RunTaskRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: RunTaskRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    if (typeof value.runId !== 'string' || typeof value.finishedAt !== 'string') continue;
    const findings = Array.isArray(value.findings)
      ? value.findings.map(parseFinding).filter((finding): finding is TaskFinding => finding !== null)
      : [];
    const openQuestions = Array.isArray(value.openQuestions)
      ? value.openQuestions.filter((entry): entry is string => typeof entry === 'string')
      : [];
    records.push({ runId: value.runId, finishedAt: value.finishedAt, findings, openQuestions });
  }
  return records;
}

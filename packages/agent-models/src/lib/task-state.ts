/**
 * Task state: where a run is in its work, reduced from loop events by the
 * harness (never asked of the model). One object every control can read
 * instead of re-deriving its own proxy from raw events.
 *
 * Phases:
 * - orient  — before the first workspace step (reading the request, planning)
 * - locate  — finding and reading the code or sources the change needs
 * - change  — editing; reads in between stay here while edits are unverified
 * - verify  — a command or review after an edit
 * - report  — the model answered without tool calls
 * - blocked — a limit stopped the run
 */
export type TaskPhase = 'orient' | 'locate' | 'change' | 'verify' | 'report' | 'blocked';

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
  /** Facts recorded this run, oldest first (capped; see FINDINGS_MAX). */
  findings: TaskFinding[];
};

/**
 * Size of the task, from evidence as it grows (never guessed up front):
 * small ≤2 edited files, ≤3 edits, <12 steps; long ≥40 steps or ≥8 edited
 * files; medium between. Only ever promoted within a run.
 */
export type TaskClass = 'small' | 'medium' | 'long';

/**
 * What the task asks for, which decides what counts as evidence: `change`
 * (edits, then a passing check), `research` (recorded findings about the
 * workspace), `answer` (a reply, no workspace). Inferred from the request
 * at the start and corrected by evidence (an edit makes it `change`).
 */
export type TaskShape = 'change' | 'research' | 'answer';

/** One fact the model recorded with record_finding. */
export type TaskFinding = {
  claim: string;
  /** path:line, a URL, or a quoted string. */
  evidence: string;
  topic?: string;
  iteration: number;
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
};

export const TASK_STATE_COMMANDS_MAX = 20;

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
  /** Ran while a successful edit had no command after it. */
  afterEdit: boolean;
};

export type TaskEvidence = {
  edits: number;
  failedEdits: number;
  /** Most recent last; capped (see TASK_STATE_COMMANDS_MAX). */
  commands: TaskCommand[];
  toolErrors: number;
  /** Iteration of the first successful edit not yet followed by a command; null when none. */
  unverifiedSince: number | null;
};

export type TaskStateSnapshot = {
  phase: TaskPhase;
  /** Iteration of the latest model call. */
  iteration: number;
  workingSet: WorkingSetEntry[];
  evidence: TaskEvidence;
  /** Model calls made while in each phase. */
  phaseIterations: Partial<Record<TaskPhase, number>>;
};

export const TASK_STATE_COMMANDS_MAX = 20;

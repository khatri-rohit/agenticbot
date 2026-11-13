import { EFFORT_IDLE_FLOOR_STEPS } from '@agent/agent-models';

/** Loop facts the effort floor reads; built fresh for every model call. */
export type EffortSignals = {
  iteration: number;
  /** Newest message is role user: the user's prompt or a loop nudge. */
  steering: boolean;
  toolError: boolean;
  /** edit_file, run_terminal or delegate ran since the last call. */
  wrote: boolean;
  /**
   * Model steps since the latest evidence of any type (an edit, a passing
   * check, a recorded finding, merged sub-agent findings), from task state.
   */
  idleSteps: number;
};

export type EffortFloorReason =
  | 'first_turn'
  | 'tool_error'
  | 'write_or_exec'
  | 'steering'
  | 'no_progress'
  | 'none';

/**
 * Lowest rung effort may take this call, and why. Events (first turn, a
 * failed tool, a write, a new instruction) hold the baseline for that call.
 * So does a stretch without evidence (F-4): a run that has stopped
 * progressing is the run that most needs to think, so effort drops below
 * the baseline only while evidence keeps arriving (repetitive progress).
 */
export function effortFloor(
  signals: EffortSignals,
  baselineIndex: number,
): { index: number; reason: EffortFloorReason } {
  if (signals.iteration <= 1) return { index: baselineIndex, reason: 'first_turn' };
  if (signals.toolError) return { index: baselineIndex, reason: 'tool_error' };
  if (signals.wrote) return { index: baselineIndex, reason: 'write_or_exec' };
  if (signals.steering) return { index: baselineIndex, reason: 'steering' };
  if (signals.idleSteps >= EFFORT_IDLE_FLOOR_STEPS) return { index: baselineIndex, reason: 'no_progress' };
  return { index: 0, reason: 'none' };
}

/**
 * A floor that holds over many calls rather than marking one event: System 1
 * is not asked again just because it holds (asks happen at boundaries).
 */
export function isSteadyFloor(reason: EffortFloorReason): boolean {
  return reason === 'none' || reason === 'no_progress';
}

/**
 * One rung above the baseline after a tool error or a steering note
 * (flags.effortEscalation), held until the next evidence: the run is helped
 * past the trouble, then effort follows progress again instead of staying
 * raised for the rest of a long run. `escalatedAt` is the evidence count
 * when it was raised (null while not raised).
 */
export function escalationStep(input: {
  escalatedAt: number | null;
  evidenceCount: number;
  /** A tool error or a steering note before this call. */
  trouble: boolean;
}): { escalatedAt: number | null; change: 'escalate' | 'release' | null } {
  const { escalatedAt, evidenceCount, trouble } = input;
  if (escalatedAt !== null && evidenceCount > escalatedAt) {
    return trouble ? { escalatedAt: evidenceCount, change: null } : { escalatedAt: null, change: 'release' };
  }
  if (escalatedAt === null && trouble) return { escalatedAt: evidenceCount, change: 'escalate' };
  return { escalatedAt, change: null };
}

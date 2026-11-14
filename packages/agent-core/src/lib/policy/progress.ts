import { CLASS_PACE_TOKENS, PROGRESS_MARKS, type RunPosture, type TaskClass } from '@agent/agent-models';

/**
 * Which progress decisions apply to a run. Stall advice applies to every
 * capped top-level run, whatever its shape: evidence is typed (an edit, a
 * passing check, a recorded finding), so a research run stalls the same way
 * a change run does. The research gate (closing the run's own web tools)
 * stays with runs that can act on the workspace instead (Agent posture with
 * edit_file): a read-only run has nothing else to fall back on, and the
 * harness never blocks a run that has no other way forward.
 */
export function progressScope(input: {
  capped: boolean;
  depth: number;
  posture: RunPosture;
  canEdit: boolean;
}): { stall: boolean; gate: boolean } {
  const stall = input.capped && input.depth === 0;
  return { stall, gate: stall && input.posture === 'agent' && input.canEdit };
}

/** The spend a task of this class is paced against, never above the run's ceiling. */
export function classPace(taskClass: TaskClass, ceiling: number): number {
  return Math.min(ceiling, CLASS_PACE_TOKENS[taskClass]);
}

/**
 * Idle-spend marks (prompt tokens). Stall is advice, so it scales from the
 * task's pace (a small task hears it sooner); the gate refuses tools, so it
 * scales from the run's ceiling (the hard budget) and never tightens as a
 * task is classed small.
 */
export function progressMarks(
  pace: number,
  ceiling: number,
  conserving: boolean,
): { stall: number; gate: number } {
  const marks = conserving ? PROGRESS_MARKS.conserve : PROGRESS_MARKS;
  return {
    stall: Math.min(pace * marks.stallRatio, marks.stallMaxTokens),
    gate: Math.min(ceiling * marks.gateRatio, marks.gateMaxTokens),
  };
}

/** What counts as evidence, in the words the card and refusals use. */
export const EVIDENCE_WORDS = 'an edit, a passing check, a recorded finding or a sub-agent report';

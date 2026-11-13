import { PROGRESS_MARKS, type RunPosture } from '@agent/agent-models';

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

/** Idle-spend marks (prompt tokens) for a run with this budget. */
export function progressMarks(
  maxPromptTokens: number,
  conserving: boolean,
): { stall: number; gate: number } {
  const marks = conserving ? PROGRESS_MARKS.conserve : PROGRESS_MARKS;
  return {
    stall: Math.min(maxPromptTokens * marks.stallRatio, marks.stallMaxTokens),
    gate: Math.min(maxPromptTokens * marks.gateRatio, marks.gateMaxTokens),
  };
}

/** What counts as evidence, in the words the card and refusals use. */
export const EVIDENCE_WORDS = 'an edit, a passing check, a recorded finding or a sub-agent report';

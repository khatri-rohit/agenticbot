import { CARD_MARKS, type RunPosture, type TaskClass, type TaskCommand, type TaskShape } from '@agent/agent-models';

/**
 * What the harness card's open items and advice may read: task state plus
 * the few run facts the harness cannot act on itself (P5: advice only where
 * the model has to decide). Built by loop/state-card from the run state.
 */
export type CardFacts = {
  shape: TaskShape;
  posture: RunPosture;
  taskClass: TaskClass;
  canDelegate: boolean;
  canRecord: boolean;
  edits: number;
  /** Iteration of the first edit with no check after it; null when none. */
  unverifiedSince: number | null;
  lastCheck: TaskCommand | null;
  reviewed: boolean;
  /** Files re-read after their read left the prompt that no finding cites. */
  rereadPaths: string[];
  /** Sub-agents' open questions, oldest first. */
  childGaps: string[];
  /** Turns in a row whose only call was one read. */
  serialReadTurns: number;
  /** Idle spend past the stall mark (policy/progress), when stalled. */
  stall?: { idle: number; max: number };
  /** The run budget is nearly spent. */
  nearBudget: boolean;
};

/** One item the card shows, with the values its wording needs. */
export type CardItem =
  | { id: 'open:unchecked'; since: number }
  | { id: 'open:check_failed'; command: string; exitCode: number }
  | { id: 'open:review' }
  | { id: 'open:reread'; paths: string[] }
  | { id: 'open:child_gaps'; gaps: string[] }
  | { id: 'advice:serial_reads'; turns: number }
  | { id: 'advice:stall'; idle: number; max: number }
  | { id: 'advice:budget' };

/**
 * The card's open items and advice, each with its precondition, in the
 * order the card prints them. Every item is a condition that still holds
 * (it leaves the card when the condition clears), never a one-time note.
 */
export function cardItems(f: CardFacts): CardItem[] {
  const items: CardItem[] = [];
  // Edits with no check after them: a change is not done until a check passes.
  if (f.unverifiedSince !== null) items.push({ id: 'open:unchecked', since: f.unverifiedSince });
  const lastCheck = f.lastCheck;
  if (lastCheck && lastCheck.exitCode !== undefined && lastCheck.exitCode !== 0 && f.unverifiedSince === null) {
    items.push({ id: 'open:check_failed', command: lastCheck.command, exitCode: lastCheck.exitCode });
  }
  // Review only for larger changes that already pass their check, once.
  if (
    f.posture === 'agent' &&
    f.canDelegate &&
    f.taskClass !== 'small' &&
    f.edits > 0 &&
    f.unverifiedSince === null &&
    lastCheck?.exitCode === 0 &&
    !f.reviewed
  ) {
    items.push({ id: 'open:review' });
  }
  // Measured waste only: files the model paid a step to read again after
  // their read left the prompt, that no finding stands for.
  if (f.shape !== 'change' && f.canRecord && f.rereadPaths.length > 0) {
    items.push({ id: 'open:reread', paths: f.rereadPaths });
  }
  // Sub-agent findings are already in the record; what is left is their gaps.
  if (f.childGaps.length > 0) items.push({ id: 'open:child_gaps', gaps: f.childGaps });

  if (f.serialReadTurns >= CARD_MARKS.serialReadAdviceAfter) {
    items.push({ id: 'advice:serial_reads', turns: f.serialReadTurns });
  }
  if (f.stall) items.push({ id: 'advice:stall', idle: f.stall.idle, max: f.stall.max });
  if (f.nearBudget) items.push({ id: 'advice:budget' });
  return items;
}

/**
 * Whether the card goes out this call: always when it has something to say
 * (items or recorded findings); otherwise not on the first quiet steps, and
 * not before the run has a working set to show.
 */
export function cardDue(input: { hasNews: boolean; step: number; workingSetSize: number }): boolean {
  return input.hasNews || (input.step > CARD_MARKS.quietSteps && input.workingSetSize > 0);
}

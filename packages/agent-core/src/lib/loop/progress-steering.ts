import { PROGRESS_MARKS, type TaskClass } from '@agent/agent-models';

import { classPace, progressMarks } from '../policy';
import type { RunBudget } from './run-budget';

/**
 * Spend since the last evidence steers a run: stall advice on the card,
 * then, for a run that can act on the workspace, its own web research closes
 * until the next evidence, and a run that only retries closed web tools
 * ends. Which runs get which is policy/progress `progressScope`; the marks
 * are policy/progress `progressMarks`. What counts as evidence is the task
 * state's one definition (TaskStateTracker.noteEvidence), read through
 * `evidence()`; this class prices the idle stretch in tokens. Stall advice
 * also needs `PROGRESS_MARKS.stallMinIdleSteps` steps without evidence
 * (`idleSteps()`, from task state): spend alone is not a stall, because
 * with a large prompt two calls pass the token mark.
 */
export class ProgressSteering {
  private spentAtProgress = 0;
  private evidenceAtProgress = 0;
  private stallNudged = false;
  private gateTraced = false;
  private gatedThisTurn = 0;
  private gatedTurnStreak = 0;

  constructor(
    private readonly budget: RunBudget,
    private readonly scope: { stall: boolean; gate: boolean },
    private readonly conserving: () => boolean,
    /** Evidence moments so far (task state); idle spend restarts when it moves. */
    private readonly evidence: () => number,
    /** The task's class (task state): sets the pace stall is measured against. */
    private readonly taskClass: () => TaskClass = () => 'long',
    /** Model steps since the latest evidence (task state `stepsSinceEvidence`). */
    private readonly idleSteps: () => number = () => Number.POSITIVE_INFINITY,
  ) {}

  private marks(): { stall: number; gate: number; pace: number; ceiling: number } {
    const ceiling = this.budget.maxPromptTokens!;
    const pace = classPace(this.taskClass(), ceiling);
    return { ...progressMarks(pace, ceiling, this.conserving()), pace, ceiling };
  }

  private markProgress(): void {
    this.spentAtProgress = this.budget.spent();
    this.evidenceAtProgress = this.evidence();
    this.stallNudged = false;
    this.gateTraced = false;
  }

  /** Prompt tokens spent since the last evidence. */
  idleTokens(): number {
    if (this.evidence() > this.evidenceAtProgress) this.markProgress();
    return this.budget.spent() - this.spentAtProgress;
  }

  /** The run's own web tools are closed until the next evidence. */
  researchGated(): boolean {
    if (!this.scope.gate) return false;
    return this.idleTokens() >= this.marks().gate;
  }

  /** Count one refused web call; true for the first refusal since progress. */
  noteGated(): boolean {
    this.gatedThisTurn += 1;
    if (this.gateTraced) return false;
    this.gateTraced = true;
    return true;
  }

  startTurn(): void {
    this.gatedThisTurn = 0;
  }

  /**
   * Close a turn. Returns the streak once every call of `maxGatedTurns` turns
   * in a row was refused by the gate (time to end the run), else null.
   */
  endTurn(halted: boolean, toolCallCount: number): number | null {
    this.gatedTurnStreak =
      !halted && this.gatedThisTurn > 0 && this.gatedThisTurn === toolCallCount
        ? this.gatedTurnStreak + 1
        : 0;
    return this.gatedTurnStreak >= PROGRESS_MARKS.maxGatedTurns ? this.gatedTurnStreak : null;
  }

  /** Idle spend while it is past the stall mark (not consumed: the harness card reads it every call). */
  stalled(): { idle: number; max: number; pace: number; taskClass: TaskClass } | undefined {
    if (!this.scope.stall) return undefined;
    const marks = this.marks();
    const idle = this.idleTokens();
    if (this.idleSteps() < PROGRESS_MARKS.stallMinIdleSteps) return undefined;
    return idle >= marks.stall ? { idle, max: marks.ceiling, pace: marks.pace, taskClass: this.taskClass() } : undefined;
  }

  /** Idle spend, once per stretch without progress when it crosses the nudge mark. */
  takeStallNudge(): { idle: number; max: number; pace: number; taskClass: TaskClass } | undefined {
    if (this.stallNudged) return undefined;
    const stall = this.stalled();
    if (!stall) return undefined;
    this.stallNudged = true;
    return stall;
  }
}

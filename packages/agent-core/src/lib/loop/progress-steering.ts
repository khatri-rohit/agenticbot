import { PROGRESS_MARKS } from '@agent/agent-models';

import { progressMarks } from '../policy';
import type { RunBudget } from './run-budget';

/**
 * Spend since the last evidence steers a run: stall advice on the card,
 * then, for a run that can act on the workspace, its own web research closes
 * until the next evidence, and a run that only retries closed web tools
 * ends. Which runs get which is policy/progress `progressScope`; the marks
 * are policy/progress `progressMarks`. What counts as evidence is the task
 * state's one definition (TaskStateTracker.noteEvidence), read through
 * `evidence()`; this class only prices the idle stretch in tokens.
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
  ) {}

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
    return this.idleTokens() >= progressMarks(this.budget.maxPromptTokens!, this.conserving()).gate;
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
  stalled(): { idle: number; max: number } | undefined {
    if (!this.scope.stall) return undefined;
    const max = this.budget.maxPromptTokens!;
    const idle = this.idleTokens();
    return idle >= progressMarks(max, this.conserving()).stall ? { idle, max } : undefined;
  }

  /** Idle spend, once per stretch without progress when it crosses the nudge mark. */
  takeStallNudge(): { idle: number; max: number } | undefined {
    if (this.stallNudged) return undefined;
    const stall = this.stalled();
    if (!stall) return undefined;
    this.stallNudged = true;
    return stall;
  }
}

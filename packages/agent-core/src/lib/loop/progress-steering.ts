import type { RunBudget } from './run-budget';

/** Share of maxPromptTokens spent with no progress before the loop steers once. */
const STALL_NUDGE_RATIO = 0.3;
/** Past this share with no progress, the parent's own web tools close until progress. */
const RESEARCH_GATE_RATIO = 0.5;
/** Tighter marks while the host says account capacity is behind pace. */
const STALL_NUDGE_RATIO_CONSERVE = 0.2;
const RESEARCH_GATE_RATIO_CONSERVE = 0.35;
/** Turns in a row whose every call hit the research gate before the run ends with a handoff. */
const MAX_GATED_TURNS = 2;

/**
 * Spend since the last progress (a successful edit, or a finished sub-agent)
 * steers a run that can edit: one nudge to act, then its own web research
 * closes until it makes progress, and a run that only retries closed web
 * tools ends. Only a capped parent run in Agent posture with edit_file is
 * steered; `enabled` is false for every other run.
 */
export class ProgressSteering {
  private spentAtProgress = 0;
  private childCallsAtProgress = 0;
  private stallNudged = false;
  private gateTraced = false;
  private gatedThisTurn = 0;
  private gatedTurnStreak = 0;

  constructor(
    private readonly budget: RunBudget,
    private readonly enabled: boolean,
    private readonly conserving: () => boolean,
  ) {}

  markProgress(): void {
    this.spentAtProgress = this.budget.spent();
    this.childCallsAtProgress = this.budget.childCalls();
    this.stallNudged = false;
    this.gateTraced = false;
  }

  /** Prompt tokens spent since the last progress. A finished sub-agent counts as progress. */
  idleTokens(): number {
    if (this.budget.childCalls() > this.childCallsAtProgress) this.markProgress();
    return this.budget.spent() - this.spentAtProgress;
  }

  /** The parent's own web tools are closed until the next progress. */
  researchGated(): boolean {
    const ratio = this.conserving() ? RESEARCH_GATE_RATIO_CONSERVE : RESEARCH_GATE_RATIO;
    return this.enabled && this.idleTokens() >= this.budget.maxPromptTokens! * ratio;
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
   * Close a turn. Returns the streak once every call of MAX_GATED_TURNS turns
   * in a row was refused by the gate (time to end the run), else null.
   */
  endTurn(halted: boolean, toolCallCount: number): number | null {
    this.gatedTurnStreak =
      !halted && this.gatedThisTurn > 0 && this.gatedThisTurn === toolCallCount
        ? this.gatedTurnStreak + 1
        : 0;
    return this.gatedTurnStreak >= MAX_GATED_TURNS ? this.gatedTurnStreak : null;
  }

  /** Idle spend, once per stretch without progress when it crosses the nudge mark. */
  takeStallNudge(): { idle: number; max: number } | undefined {
    if (this.stallNudged || !this.enabled) return undefined;
    const max = this.budget.maxPromptTokens!;
    const idle = this.idleTokens();
    const ratio = this.conserving() ? STALL_NUDGE_RATIO_CONSERVE : STALL_NUDGE_RATIO;
    if (idle < max * ratio) return undefined;
    this.stallNudged = true;
    return { idle, max };
  }
}

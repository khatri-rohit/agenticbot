import { limitMessage } from './limits';

/** Invented tool names in one run before hard halt (I1 + I6). */
const MAX_UNKNOWN_TOOL_STREAK = 2;
/** Distinct read_file admits per path per run (stops offset paging storms). */
const MAX_READ_FILE_PER_PATH = 30;
/** run_terminal admits per run (stops shell flood; migrations run 40+ builds). */
const MAX_TERMINAL_CALLS = 60;
/** Identical mutate call+result before stuck halt. */
const MAX_IDENTICAL_OUTCOMES = 3;

/**
 * Per-run memory of what the model already tried, so a run that is going in
 * circles stops instead of spending its budget: invented tool names, paging
 * one file or flooding the shell, repeating the exact same call, or getting
 * the exact same outcome again. Limit methods return a `limit.*` reason when
 * a cap is hit, else null.
 */
export class RepetitionGuard {
  private unknownToolStreak = 0;
  private readonly readsByPath = new Map<string, number>();
  private terminalCalls = 0;
  private readonly callCounts = new Map<string, number>();
  private readonly outcomeCounts = new Map<string, number>();
  /** Exec outcome keys, so a successful edit can clear them (an edit between identical builds is progress). */
  private readonly execOutcomeKeys = new Set<string>();

  unknownTool(): string | null {
    this.unknownToolStreak += 1;
    if (this.unknownToolStreak < MAX_UNKNOWN_TOOL_STREAK) return null;
    return limitMessage(
      'limit.unknown',
      `unknown tool streak exceeded (${MAX_UNKNOWN_TOOL_STREAK})`,
    );
  }

  /** A valid tool breaks the unknown streak (a lifetime total was ending runs early). */
  knownTool(): void {
    this.unknownToolStreak = 0;
  }

  readStorm(readPath: string): string | null {
    if ((this.readsByPath.get(readPath) ?? 0) < MAX_READ_FILE_PER_PATH) return null;
    return limitMessage(
      'limit.read_storm',
      `read_file path storm blocked (${MAX_READ_FILE_PER_PATH} per path)`,
    );
  }

  terminalStorm(): string | null {
    if (this.terminalCalls < MAX_TERMINAL_CALLS) return null;
    return limitMessage(
      'limit.terminal',
      `run_terminal storm blocked (${MAX_TERMINAL_CALLS} per run)`,
    );
  }

  /** Count one attempt of this exact call; returns how many times it has been made. */
  countCall(callKey: string): number {
    const count = (this.callCounts.get(callKey) ?? 0) + 1;
    this.callCounts.set(callKey, count);
    return count;
  }

  /** A call passed admission and will run. */
  admitted(toolName: string, readPath: string | null): void {
    if (readPath !== null) {
      this.readsByPath.set(readPath, (this.readsByPath.get(readPath) ?? 0) + 1);
    }
    if (toolName === 'run_terminal') this.terminalCalls += 1;
  }

  /** A retired skill body may be loaded again: that is not a repeat. */
  forgetSkillLoads(): void {
    for (const key of [...this.callCounts.keys()]) {
      if (key.startsWith('load_skill:')) this.callCounts.delete(key);
    }
  }

  /**
   * Count one outcome (call + result). `nearStuck` is the second identical
   * outcome, `stuck` the limit.
   */
  recordOutcome(key: string, exec: boolean): { nearStuck: boolean; stuck: boolean } {
    const count = (this.outcomeCounts.get(key) ?? 0) + 1;
    this.outcomeCounts.set(key, count);
    if (exec) this.execOutcomeKeys.add(key);
    return {
      nearStuck: count === MAX_IDENTICAL_OUTCOMES - 1,
      stuck: count >= MAX_IDENTICAL_OUTCOMES,
    };
  }

  /** A successful edit makes earlier build/test exits stale: start counting fresh. */
  editSucceeded(): void {
    for (const key of this.execOutcomeKeys) this.outcomeCounts.delete(key);
    this.execOutcomeKeys.clear();
  }
}

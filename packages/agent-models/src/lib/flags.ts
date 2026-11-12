/**
 * Harness behaviour switches, one per component that changes what the model
 * sees. Resolved once by the host when a run starts, recorded on the run's
 * `run_start` trace, and never flipped mid-run, so an eval can tell which
 * behaviour produced a trace.
 */
export type HarnessFlags = {
  /** Old tool results become one-line outcome cards instead of bare stubs. */
  outcomeCards: boolean;
  /**
   * One leading system message (identity, tools, skills index, memory,
   * rules, brief); per-send context (plan, picks, mentions, last run,
   * situation) rides in the current user turn instead of mid-history
   * system messages, which many open-model chat templates mishandle.
   */
  promptTiers: boolean;
  /** Loop-control notes the harness adds as `user` rows say they come from the harness. */
  harnessNotes: boolean;
  /**
   * Home gets a short identity and compact tool guidance; the long house
   * style stays in the ai-writing-guidelines skill. A voice change: off
   * until reviewed.
   */
  compactHomePrompt: boolean;
  /**
   * Each send carries a deterministic situation card (the previous answer's
   * lead next to the new message) and a harness evidence log (edits,
   * commands, failures) that survives compaction.
   */
  situationCard: boolean;
  /**
   * After a tool error or a harness steering note, the rest of the run uses
   * one reasoning rung above the baseline. It never steps back down.
   */
  effortEscalation: boolean;
  /**
   * An Agent run that edited files and then claims success without running
   * a command since its last edit is sent back once to verify.
   */
  stopCheck: boolean;
  /** Between-run compaction asks a side model for a sectioned summary; the extractive one is the fallback. */
  sectionedSummary: boolean;
  /** After a thread goes idle, a side model proposes memory updates, staged for the user's approval. */
  learningLoop: boolean;
  /**
   * One ephemeral harness card (task state, budget, advice) is appended to
   * each model call instead of appending notes to tool results and the
   * prompt. Off = the earlier notes, for A/B.
   */
  stateCard: boolean;
};

export const DEFAULT_HARNESS_FLAGS: HarnessFlags = {
  outcomeCards: true,
  promptTiers: true,
  harnessNotes: true,
  compactHomePrompt: false,
  situationCard: true,
  effortEscalation: true,
  stopCheck: true,
  sectionedSummary: true,
  learningLoop: true,
  stateCard: true,
};

const FLAG_NAMES = Object.keys(DEFAULT_HARNESS_FLAGS) as Array<keyof HarnessFlags>;

function isFlagName(name: string): name is keyof HarnessFlags {
  return (FLAG_NAMES as string[]).includes(name);
}

/**
 * Parse `name:on,name:off` (e.g. the host's AGENT_FLAGS env). Unknown names
 * and values are ignored; missing names keep their default.
 */
export function parseHarnessFlags(raw: string | undefined): HarnessFlags {
  const flags: HarnessFlags = { ...DEFAULT_HARNESS_FLAGS };
  for (const part of (raw ?? '').split(',')) {
    const [name = '', value] = part.split(':').map((piece) => piece.trim());
    if (!isFlagName(name)) continue;
    if (value === 'on') flags[name] = true;
    if (value === 'off') flags[name] = false;
  }
  return flags;
}

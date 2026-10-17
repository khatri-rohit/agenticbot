/**
 * Token budget for assembleContext (M2). Numbers are illustrative until measured.
 */
export type ContextBudget = {
  /** Total model context window. */
  windowTokens: number;
  /** Reserved for the model's answer. */
  outputReserveTokens: number;
  /** Soft trigger for compaction (e.g. 0.65). */
  compactAtRatio: number;
};

/** Per-layer sizes returned with an assembled prompt for the context meter. */
export type ContextReportLayer = {
  id: string;
  label: string;
  tokens: number;
};

export type ContextReport = {
  budget: ContextBudget;
  layers: ContextReportLayer[];
  /** Sum of layer tokens (excludes output reserve). */
  occupiedTokens: number;
};

/**
 * Derived compacted window + thread brief. Regenerable; not authoritative history.
 * Full movie remains the ledger.
 */
export type Snapshot = {
  threadId: string;
  /** Ledger seq this snapshot covers through (inclusive). */
  throughSeq: number;
  model: string;
  /** Prompt / assembler version for eval diffs. */
  promptVersion?: string;
  /** Short screenplay for the thread (goal, decisions, open questions). */
  brief: string;
  /** Compacted older turns summary kept in the model window. */
  summary: string;
  createdAt: string;
};

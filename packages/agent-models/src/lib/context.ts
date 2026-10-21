/**
 * Token budget for assembleContext. Numbers are defaults until /api/show
 * supplies a real window.
 */
export type ContextBudget = {
  /** Total model context window. */
  windowTokens: number;
  /** Reserved for the model's answer. */
  outputReserveTokens: number;
  /** Soft trigger for compaction (e.g. 0.65). M2 reports this; M4 acts on it. */
  compactAtRatio: number;
  /** Per-call cap before a tool result is stubbed even in the recent tail. */
  toolResultMaxTokens: number;
  /** Tool results older than this many user turns become stubs. */
  keepToolResultsForTurns: number;
  /** Image attachments older than this many user turns become text stubs. */
  keepAttachmentsForTurns: number;
};

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  windowTokens: 128_000,
  outputReserveTokens: 20_000,
  compactAtRatio: 0.65,
  /** ~16k chars; cards are small, slices max 8k — keep recent research readable. */
  toolResultMaxTokens: 4_000,
  keepToolResultsForTurns: 2,
  keepAttachmentsForTurns: 2,
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
  stubbedToolResults: number;
  needsCompaction: boolean;
};

/**
 * Derived compacted window + thread brief. Regenerable; not authoritative history.
 * Full movie remains the ledger. Written in M4; M2 assembler accepts null.
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

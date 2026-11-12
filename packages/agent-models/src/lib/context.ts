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
  /** Between-run compaction cuts older turns until history fits this share of the input budget. */
  compactToRatio: number;
  /**
   * Cap on this run's resident tool results (the working set). Past it, the
   * least recently touched results become cards at once. Absolute on
   * purpose: every call re-sends them, so per-call cost stays bounded on a
   * 1M window.
   */
  inRunResidentToolTokens: number;
  /**
   * A file not read or edited for this many iterations (other results: this
   * many iterations old) is cold and becomes a card. Files edited since the
   * last check stay resident.
   */
  inRunColdAfterIterations: number;
  /** Newest non-file tool results that never go cold; also the in-run recap's kept iterations. */
  inRunKeepToolResults: number;
  /** Skip a cold/superseded pass that frees less than this (each pass breaks the cached prefix). */
  inRunClearAtLeastTokens: number;
  /** In-run extractive compaction of the current turn starts at this share of the input budget. */
  inRunCompactRatio: number;
  /** In-run compaction folds iterations until the prompt is under this share (low mark). */
  inRunCompactToRatio: number;
  /** Iterations a loaded skill body stays in full before it becomes a skill card. */
  skillResidentIterations: number;
};

/**
 * Which window a thread budgets against. `default` caps at 200k (or the
 * model's size when smaller); `model` uses the model's full reported size.
 */
export type ContextWindowMode = 'default' | 'model';

/**
 * Provenance of ContextReport.budget.windowTokens (host sets after assemble).
 * `served`: a local daemon runs the model with a smaller context than the
 * chosen window, so the window was clamped to what is actually served.
 */
export type ContextWindowSource = 'default' | 'model' | 'fallback' | 'served';

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 200_000;

/**
 * Smallest window a run starts on. Below it the system prompt, tool schemas
 * and one real file read leave too little room for the conversation, so the
 * host refuses the send with a clear message instead of running degraded.
 */
export const MIN_CONTEXT_WINDOW_TOKENS = 32_000;

export const DEFAULT_CONTEXT_BUDGET: ContextBudget = {
  windowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
  outputReserveTokens: 20_000,
  compactAtRatio: 0.65,
  /** ~16k chars; cards are small, slices max 8k — keep recent research readable. */
  toolResultMaxTokens: 4_000,
  keepToolResultsForTurns: 2,
  keepAttachmentsForTurns: 2,
  compactToRatio: 0.25,
  inRunResidentToolTokens: 24_000,
  inRunColdAfterIterations: 4,
  inRunKeepToolResults: 4,
  inRunClearAtLeastTokens: 10_000,
  inRunCompactRatio: 0.45,
  inRunCompactToRatio: 0.3,
  skillResidentIterations: 4,
};

export function parseContextWindowMode(value: unknown): ContextWindowMode | undefined {
  return value === 'default' || value === 'model' ? value : undefined;
}

/**
 * The window a run budgets against. `modelMax` is the provider-reported
 * context length (null when /api/show failed → 200k fallback). `servedMax`
 * is the context a local daemon actually loaded the model with: the
 * OpenAI-compatible endpoint cannot ask for a size, and a prompt past the
 * served size is cut from the front without an error, so it caps the window.
 */
export function resolveContextWindow(input: {
  mode?: ContextWindowMode;
  modelMax: number | null;
  servedMax?: number | null;
}): { windowTokens: number; source: ContextWindowSource } {
  const chosen = chooseContextWindow(input.mode, input.modelMax);
  const served = input.servedMax ?? 0;
  return served > 0 && served < chosen.windowTokens
    ? { windowTokens: served, source: 'served' }
    : chosen;
}

function chooseContextWindow(
  mode: ContextWindowMode | undefined,
  modelMax: number | null,
): { windowTokens: number; source: ContextWindowSource } {
  if (!modelMax || modelMax <= 0) {
    return { windowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS, source: 'fallback' };
  }
  if (mode === 'model') {
    return { windowTokens: modelMax, source: 'model' };
  }
  return {
    windowTokens: Math.min(DEFAULT_CONTEXT_WINDOW_TOKENS, modelMax),
    source: 'default',
  };
}

/** Budget for a resolved window. Absolute in-run knobs stay below the input budget. */
export function contextBudgetForWindow(
  windowTokens: number,
  base: ContextBudget = DEFAULT_CONTEXT_BUDGET,
): ContextBudget {
  const input = Math.max(1, windowTokens - base.outputReserveTokens);
  return {
    ...base,
    windowTokens,
    inRunResidentToolTokens: Math.min(base.inRunResidentToolTokens, Math.floor(input * 0.15)),
    inRunClearAtLeastTokens: Math.min(
      base.inRunClearAtLeastTokens,
      Math.floor(input * 0.1),
    ),
  };
}

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
  /** `/` picks pinned as core + contents because the pinned total passed its cap. */
  trimmedSkills?: string[];
  /**
   * Where budget.windowTokens came from for this assembly.
   * Hosts set this after assembleContext; refresh preserves it.
   */
  windowSource?: ContextWindowSource;
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

/** Parse a snapshot from persisted JSON. Rejects malformed files. */
export function parseSnapshot(raw: unknown): Snapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.threadId !== 'string') return null;
  if (typeof r.throughSeq !== 'number' || !Number.isInteger(r.throughSeq) || r.throughSeq < 0) {
    return null;
  }
  if (typeof r.model !== 'string') return null;
  if (typeof r.brief !== 'string') return null;
  if (typeof r.summary !== 'string') return null;
  if (typeof r.createdAt !== 'string') return null;
  return {
    threadId: r.threadId,
    throughSeq: r.throughSeq,
    model: r.model,
    brief: r.brief,
    summary: r.summary,
    createdAt: r.createdAt,
    ...(typeof r.promptVersion === 'string' ? { promptVersion: r.promptVersion } : {}),
  };
}

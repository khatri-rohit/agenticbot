/**
 * Ollama model capability snapshot (from native POST /api/show).
 * Shared contract between @agent/agent-core discovery, API JSON, and the web UI.
 * Zero runtime deps — shapes only.
 */

/** Chat + native API target: cloud (OLLAMA_BASE_URL) or local daemon. */
export type OllamaEndpoint = 'cloud' | 'local';

/** One row from Ollama GET /api/tags (installed models). */
export type OllamaListedModel = {
  id: string;
  size: number | null;
  modifiedAt: string | null;
  family: string | null;
};

export type ThinkingValue = boolean | string;

export type ThinkingMode = 'none' | 'boolean' | 'levels' | 'mixed';

export type OllamaThinkingConfig = {
  supported: boolean;
  values: ThinkingValue[];
  default: ThinkingValue | null;
  mode: ThinkingMode;
};

export type OllamaModelConfig = {
  model: string;
  capabilities: string[];
  contextLength: number | null;
  thinking: OllamaThinkingConfig;
  supportsTools: boolean;
  supportsVision: boolean;
};

/**
 * Ollama Cloud balance — from GET https://ollama.com/api/balance.
 * Two plan shapes: legacy (session + weekly remaining %) or modern (USD balance).
 */

export type OllamaBalanceLimit = {
  remainingPercent: number;
  resetsAt: string;
};

export type OllamaBalanceLegacy = {
  session: OllamaBalanceLimit;
  weekly: OllamaBalanceLimit;
};

export type OllamaBalanceModern = {
  balanceUsd: number;
  allowanceUsd: number;
  period: { from: string; until: string };
};

export type OllamaBalance = {
  legacy?: OllamaBalanceLegacy;
  modern?: OllamaBalanceModern;
  purchasedUsd?: number;
};

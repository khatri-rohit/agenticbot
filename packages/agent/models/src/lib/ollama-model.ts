/**
 * Ollama model capability snapshot (from native POST /api/show).
 * Shared contract between @org/agent-core discovery, API JSON, and the web UI.
 * Zero runtime deps — shapes only.
 */

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

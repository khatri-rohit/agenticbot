import type { TokenUsage } from '@org/agent-models';

type UsageLike = {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
};

/**
 * Map OpenAI-compat / Ollama `usage` objects into domain TokenUsage.
 * Returns undefined when prompt_tokens is missing or not a finite number.
 */
export function parseTokenUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as UsageLike;
  const promptTokens = u.prompt_tokens;
  if (typeof promptTokens !== 'number' || !Number.isFinite(promptTokens)) {
    return undefined;
  }
  const completionTokens =
    typeof u.completion_tokens === 'number' &&
    Number.isFinite(u.completion_tokens)
      ? u.completion_tokens
      : 0;
  const totalTokens =
    typeof u.total_tokens === 'number' && Number.isFinite(u.total_tokens)
      ? u.total_tokens
      : undefined;
  return {
    promptTokens,
    completionTokens,
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

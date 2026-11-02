import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';

import { getClient, getOllamaModelConfig, resolveReasoningEffort } from '@agent/agent-core';
import { clampChatTitle, type OllamaEndpoint } from '@agent/agent-models';

/** Bounds how long POST /run waits on the title (it awaits it). */
const TITLE_TIMEOUT_MS = 4_000;

/**
 * TITLE_MODEL (a cloud id) on cloud runs; the run's own model on local runs,
 * where a cloud id would not exist.
 */
function titleModelFor(runModel: string, endpoint: OllamaEndpoint): string {
  const configured = process.env.TITLE_MODEL?.trim();
  return endpoint === 'cloud' && configured ? configured : runModel;
}

/**
 * Thinking off, but only if that model offers off. Otherwise its default:
 * a value it lists is never replaced by one it would reject.
 */
async function titleReasoningEffort(model: string, endpoint: OllamaEndpoint): Promise<string | undefined> {
  try {
    const config = await getOllamaModelConfig(model, endpoint);
    return config.thinking.values.includes(false) ? resolveReasoningEffort(config, false) : undefined;
  } catch {
    return undefined;
  }
}

/** Fallback when the model call fails or the message is empty. */
export function seedThreadTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim();
  if (!trimmed) return 'New Chat';
  return clampChatTitle(trimmed);
}

/**
 * Short title via TITLE_MODEL (cloud) or the run's model, with thinking off
 * where the model allows it: thinking tokens count against max_tokens and
 * can leave the title empty. Falls back to a clamped first-message snippet
 * when the call fails, times out, or returns nothing.
 */
export async function generateThreadTitle(
  firstMessage: string,
  model: string,
  endpoint: OllamaEndpoint = 'cloud',
): Promise<string> {
  const fallback = seedThreadTitle(firstMessage);
  const snippet = firstMessage.trim().slice(0, 1000);
  if (!snippet) return fallback;

  try {
    const titleModel = titleModelFor(model, endpoint);
    const reasoningEffort = await titleReasoningEffort(titleModel, endpoint);
    const params = {
      model: titleModel,
      stream: false as const,
      max_tokens: 50,
      temperature: 0.5,
      ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
      messages: [
        {
          role: 'system' as const,
          content:
            'Generate a concise chat title of 5 to 7 words that summarizes the topic. Reply with only the title — no quotes, no trailing punctuation.',
        },
        { role: 'user' as const, content: snippet },
      ],
    };
    // Ollama's reasoning_effort is wider than the SDK's enum — cast at the boundary.
    const response = await getClient(endpoint).chat.completions.create(
      params as ChatCompletionCreateParamsNonStreaming,
      { signal: AbortSignal.timeout(TITLE_TIMEOUT_MS) },
    );

    const raw = response.choices[0]?.message?.content?.trim() ?? '';
    const cleaned = raw.replace(/^["']|["']$/g, '');
    return clampChatTitle(cleaned, fallback);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[title] generate failed:', message);
    return fallback;
  }
}

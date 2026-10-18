import { getClient } from '@org/agent-core';
import { clampChatTitle, type OllamaEndpoint } from '@org/agent-models';

/** Fallback when the model call fails or the message is empty. */
export function seedThreadTitle(firstMessage: string): string {
  const trimmed = firstMessage.trim();
  if (!trimmed) return 'New Chat';
  return clampChatTitle(trimmed);
}

/**
 * Short title via the same chat model the run uses.
 * Falls back to a clamped first-message snippet only if the model call fails.
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
    const response = await getClient(endpoint).chat.completions.create({
      model,
      stream: false,
      max_tokens: 50,
      temperature: 0.5,
      messages: [
        {
          role: 'system',
          content:
            'Generate a concise chat title of 5 to 7 words that summarizes the topic. Reply with only the title — no quotes, no trailing punctuation.',
        },
        { role: 'user', content: snippet },
      ],
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? '';
    const cleaned = raw.replace(/^["']|["']$/g, '');
    return clampChatTitle(cleaned, fallback);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[title] generate failed:', message);
    return fallback;
  }
}

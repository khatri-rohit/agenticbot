import type { TokenUsage } from './run.js';

/** Rough char→token stand-in when a real tokenizer is not available. */
export const CHARS_PER_TOKEN = 4;

/** Rough stand-in when the vision tokenizer is unknown. */
export const ESTIMATED_TOKENS_PER_IMAGE = 1000;

/**
 * Window fill for the request that just ran. Completion sits in the
 * output reserve until the next prompt includes it.
 */
export function occupiedFromUsage(usage: TokenUsage): number {
  return usage.promptTokens;
}

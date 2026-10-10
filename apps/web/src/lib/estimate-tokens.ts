import type { MessageAttachment } from '@org/agent-models';

/** Rough stand-in when the real vision tokenizer is unknown. */
const ESTIMATED_TOKENS_PER_IMAGE = 1000;

/**
 * Rough context meter: ~4 chars per token, plus a fixed per-image
 * estimate so vision attachments do not look "free" in the UI.
 */
export function estimateTokens(
  messages: Array<{
    content?: string | null;
    toolCalls?: unknown;
    attachments?: MessageAttachment[];
  }>,
  extras: Array<string | null | undefined> = [],
  pendingAttachments = 0,
): number {
  let tokenEstimate = 0;
  for (const message of messages) {
    tokenEstimate += Math.ceil((message.content?.length ?? 0) / 4);
    if (message.toolCalls) {
      tokenEstimate += Math.ceil(JSON.stringify(message.toolCalls).length / 4);
    }
    tokenEstimate +=
      (message.attachments?.length ?? 0) * ESTIMATED_TOKENS_PER_IMAGE;
    tokenEstimate += 4;
  }
  for (const extra of extras) {
    if (extra) tokenEstimate += Math.ceil(extra.length / 4);
  }
  tokenEstimate += pendingAttachments * ESTIMATED_TOKENS_PER_IMAGE;
  return tokenEstimate;
}

export function formatTokenCount(n: number): string {
  return n.toLocaleString();
}

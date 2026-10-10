import type { MessageAttachment } from '@org/agent-models';
import { ESTIMATED_TOKENS_PER_IMAGE } from '@/features/agent/lib/image-attachments';

/** Rough context meter: ~4 chars per token. Not a real tokenizer. */

export function estimateTokens(
  messages: Array<{
    content?: string | null;
    toolCalls?: unknown;
    attachments?: MessageAttachment[];
  }>,
  extras: Array<string | null | undefined> = [],
  pendingAttachments = 0,
): number {
  let n = 0;
  for (const m of messages) {
    n += Math.ceil((m.content?.length ?? 0) / 4);
    if (m.toolCalls) n += Math.ceil(JSON.stringify(m.toolCalls).length / 4);
    n += (m.attachments?.length ?? 0) * ESTIMATED_TOKENS_PER_IMAGE;
    n += 4;
  }
  for (const extra of extras) {
    if (extra) n += Math.ceil(extra.length / 4);
  }
  n += pendingAttachments * ESTIMATED_TOKENS_PER_IMAGE;
  return n;
}

export function formatTokenCount(n: number): string {
  return n.toLocaleString();
}

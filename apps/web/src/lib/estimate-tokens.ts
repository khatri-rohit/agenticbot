/** Rough context meter: ~4 chars per token. Not a real tokenizer. */

export function estimateTokens(
  messages: Array<{ content?: string | null; toolCalls?: unknown }>,
  extras: Array<string | null | undefined> = [],
): number {
  let n = 0;
  for (const m of messages) {
    n += Math.ceil((m.content?.length ?? 0) / 4);
    if (m.toolCalls) n += Math.ceil(JSON.stringify(m.toolCalls).length / 4);
    n += 4;
  }
  for (const extra of extras) {
    if (extra) n += Math.ceil(extra.length / 4);
  }
  return n;
}

export function formatTokenCount(n: number): string {
  return n.toLocaleString();
}

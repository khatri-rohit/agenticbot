/**
 * LangGraph `streamMode: 'messages'` yields provider-specific message chunks.
 * This module normalizes those shapes into answer vs reasoning text for the client.
 */

export type MessageStreamPart =
  { kind: 'answer'; text: string } | { kind: 'reasoning'; text: string };

function readAnswerText(msg: Record<string, unknown>): string {
  if (typeof msg.text === 'string' && msg.text) return msg.text;
  if (typeof msg.content === 'string' && msg.content) return msg.content;

  if (Array.isArray(msg.contentBlocks)) {
    return msg.contentBlocks
      .map((block) => {
        if (!block || typeof block !== 'object') return '';
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        return '';
      })
      .join('');
  }

  return '';
}

function readReasoningText(msg: Record<string, unknown>): string | undefined {
  const kwargs = msg.additional_kwargs;
  if (!kwargs || typeof kwargs !== 'object') return undefined;
  const reasoning = (kwargs as Record<string, unknown>).reasoning_content;
  return typeof reasoning === 'string' && reasoning ? reasoning : undefined;
}

export function partsFromLangGraphMessageChunk(
  msg: unknown,
): MessageStreamPart[] {
  if (!msg || typeof msg !== 'object') return [];

  const record = msg as Record<string, unknown>;
  const parts: MessageStreamPart[] = [];

  const reasoning = readReasoningText(record);
  if (reasoning) parts.push({ kind: 'reasoning', text: reasoning });

  const answer = readAnswerText(record);
  if (answer) parts.push({ kind: 'answer', text: answer });

  return parts;
}

import type {
  ChatContentPart,
  ChatMessage,
  Message,
  MessageAttachment,
} from '@org/agent-models';

function userContentForModel(
  text: string,
  attachments: MessageAttachment[] | undefined,
): string | ChatContentPart[] {
  if (!attachments?.length) return text;

  const parts: ChatContentPart[] = [];
  const trimmed = text.trim();
  if (trimmed) {
    parts.push({ type: 'text', text: trimmed });
  }
  for (const attachment of attachments) {
    parts.push({
      type: 'image_url',
      image_url: { url: attachment.dataUrl },
    });
  }
  return parts;
}

/** Map IndexedDB history into the ChatMessage[] the run API expects. */
export function toChatContext(messages: Message[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role === 'user') {
      return {
        role: 'user',
        content: userContentForModel(message.content, message.attachments),
      };
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? '',
        content: message.content,
      };
    }
    return {
      role: 'assistant',
      content: message.content,
      ...(message.toolCalls?.length ? { tool_calls: message.toolCalls } : {}),
    };
  });
}

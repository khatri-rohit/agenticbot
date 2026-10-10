import type { ChatMessage, Message } from '@org/agent-models';
import { attachmentsToContentParts } from './image-attachments';

/** Map durable IndexedDB messages → OpenAI-shaped ChatMessage context. */
export function toChatContext(messages: Message[]): ChatMessage[] {
  return messages.map((m) => {
    if (m.role === 'user') {
      return {
        role: 'user',
        content: attachmentsToContentParts(m.content, m.attachments),
      };
    }
    if (m.role === 'tool')
      return {
        role: 'tool',
        tool_call_id: m.toolCallId ?? '',
        content: m.content,
      };
    return { role: 'assistant', content: m.content };
  });
}

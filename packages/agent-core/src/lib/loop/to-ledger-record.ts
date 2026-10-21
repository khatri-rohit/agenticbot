import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type { LedgerRecord, PendingToolCall } from '@agenticbot/agent-models';

/** Map a loop message to the durable ledger shape (wire-accurate subset). */
export function toLedgerRecord(
  message: ChatCompletionMessageParam,
): LedgerRecord {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.tool_call_id,
      content: contentToString(message.content),
    };
  }

  if (message.role === 'assistant') {
    const record: LedgerRecord = {
      role: 'assistant',
      content:
        message.content === null || message.content === undefined
          ? null
          : contentToString(message.content),
    };
    if (message.tool_calls && message.tool_calls.length > 0) {
      return {
        ...record,
        tool_calls: message.tool_calls as PendingToolCall[],
      };
    }
    return record;
  }

  if (message.role === 'system') {
    return {
      role: 'system',
      content: contentToString(message.content),
    };
  }

  // user (and any other role treated as user content for durability)
  return {
    role: 'user',
    content: contentToString(
      'content' in message ? message.content : undefined,
    ),
  };
}

function contentToString(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === null || content === undefined) return '';
  return JSON.stringify(content);
}

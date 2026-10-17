import { describe, expect, it } from 'vitest';
import type { Message } from '@org/agent-models';
import { toChatContext } from './to-chat-context';

function userMessage(
  partial: Partial<Message> & Pick<Message, 'content'>,
): Message {
  return {
    id: 'u1',
    threadId: 't1',
    runId: null,
    role: 'user',
    status: 'complete',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('toChatContext', () => {
  it('keeps string content for text-only users', () => {
    expect(toChatContext([userMessage({ content: 'hello' })])).toEqual([
      { role: 'user', content: 'hello' },
    ]);
  });

  it('emits image_url parts when attachments exist', () => {
    expect(
      toChatContext([
        userMessage({
          content: 'what is this?',
          attachments: [
            {
              id: 'a1',
              mimeType: 'image/png',
              dataUrl: 'data:image/png;base64,xyz',
            },
          ],
        }),
      ]),
    ).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,xyz' },
          },
        ],
      },
    ]);
  });

  it('preserves assistant tool_calls for the next model turn', () => {
    expect(
      toChatContext([
        {
          id: 'a1',
          threadId: 't1',
          runId: 'r1',
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'web_search', arguments: '{}' },
            },
          ],
          status: 'complete',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        {
          id: 't1m',
          threadId: 't1',
          runId: 'r1',
          role: 'tool',
          content: 'hits',
          toolCallId: 'call_1',
          status: 'complete',
          createdAt: '2026-01-01T00:00:01.000Z',
        },
      ]),
    ).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'web_search', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'hits' },
    ]);
  });

  it('omits empty text when the turn is image-only', () => {
    expect(
      toChatContext([
        userMessage({
          content: '   ',
          attachments: [
            {
              id: 'a1',
              mimeType: 'image/png',
              dataUrl: 'data:image/png;base64,xyz',
            },
          ],
        }),
      ]),
    ).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,xyz' },
          },
        ],
      },
    ]);
  });
});

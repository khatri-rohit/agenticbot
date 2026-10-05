import { describe, it, expect } from 'vitest';
import { streamModelTurn } from './stream.js';
import { client } from './client.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { ToolRegistry } from '../tools/registry.js';

// We test the tool-call accumulation logic by mocking the OpenAI client.
// The streamModelTurn function consumes an async iterable of chunks.
// We verify that fragmented tool-call chunks are correctly reconstructed.

const emptyTools: ToolRegistry = { definitions: [], byName: new Map() };
const emptyMessages: ChatCompletionMessageParam[] = [];

/** Patch the client's create method to return a fake async iterable of chunks. */
function mockStream(chunks: any[]) {
  const original = client.chat.completions.create;
  (client.chat.completions as any).create = async (opts: any) => {
    if (!opts.stream) throw new Error('mockStream expects stream:true');
    return (async function* () {
      for (const chunk of chunks) yield chunk;
    })();
  };
  return () => {
    (client.chat.completions as any).create = original;
  };
}

describe('streamModelTurn — tool-call accumulation', () => {
  it('reconstructs a single tool call from fragmented chunks', async () => {
    const restore = mockStream([
      {
        choices: [
          {
            delta: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  index: 0,
                  id: 'call_abc',
                  type: 'function',
                  function: { name: 'web_search', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"query":' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '"latest React"}' } },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [{ delta: { content: null }, finish_reason: 'tool_calls' }],
      },
    ]);

    try {
      const deltas: string[] = [];
      const turn = await streamModelTurn(
        'test-model',
        emptyMessages,
        emptyTools,
        (delta: string) => deltas.push(delta),
      );

      expect(turn.finishReason).toBe('tool_calls');
      expect(turn.content).toBe('');
      expect(turn.toolCalls).toHaveLength(1);
      expect(turn.toolCalls[0].id).toBe('call_abc');
      expect(turn.toolCalls[0].type).toBe('function');
      expect(turn.toolCalls[0].function.name).toBe('web_search');
      expect(turn.toolCalls[0].function.arguments).toBe(
        '{"query":"latest React"}',
      );
    } finally {
      restore();
    }
  });

  it('accumulates text deltas via callback', async () => {
    const restore = mockStream([
      { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
      { choices: [{ delta: { content: ' world' }, finish_reason: null }] },
      { choices: [{ delta: { content: '!' }, finish_reason: 'stop' }] },
    ]);

    try {
      const deltas: string[] = [];
      const turn = await streamModelTurn('test-model', emptyMessages, emptyTools, (delta: string) => deltas.push(delta));

      expect(turn.content).toBe('Hello world!');
      expect(turn.finishReason).toBe('stop');
      expect(turn.toolCalls).toHaveLength(0);
      expect(deltas).toEqual(['Hello', ' world', '!']);
    } finally {
      restore();
    }
  });

  it('synthesizes a missing tool-call id', async () => {
    // Some Ollama models drop the id on stream chunks.
    const restore = mockStream([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  // No id field
                  type: 'function',
                  function: { name: 'web_search', arguments: '{}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]);

    try {
      const turn = await streamModelTurn('test-model', emptyMessages, emptyTools);

      expect(turn.toolCalls).toHaveLength(1);
      expect(turn.toolCalls[0].id).toBeTruthy();
      expect(turn.toolCalls[0].id).toHaveLength(36); // UUID format
    } finally {
      restore();
    }
  });

  it('reconstructs multiple tool calls from interleaved chunks', async () => {
    const restore = mockStream([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'web_search', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: 'call_2',
                  type: 'function',
                  function: { name: 'web_search', arguments: '' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { arguments: '{"query":"a"}' } },
                { index: 1, function: { arguments: '{"query":"b"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]);

    try {
      const turn = await streamModelTurn('test-model', emptyMessages, emptyTools);

      expect(turn.toolCalls).toHaveLength(2);
      expect(turn.toolCalls[0].id).toBe('call_1');
      expect(turn.toolCalls[0].function.arguments).toBe('{"query":"a"}');
      expect(turn.toolCalls[1].id).toBe('call_2');
      expect(turn.toolCalls[1].function.arguments).toBe('{"query":"b"}');
    } finally {
      restore();
    }
  });
});
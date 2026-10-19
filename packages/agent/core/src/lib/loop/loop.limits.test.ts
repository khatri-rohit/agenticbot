import { describe, expect, it } from 'vitest';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { runLoop } from './loop';
import { createToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/type';
import type { ModelCallFn } from './types';

const noop: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'noop',
      description: 'test',
      parameters: { type: 'object', properties: {} },
    },
  },
  guidance: { whenToUse: ['test'], whenNotToUse: ['never'], usage: ['call'] },
  execute: async () => 'ok',
};

function toolTurn(
  args: string,
): Awaited<ReturnType<ModelCallFn>> {
  return {
    content: '',
    toolCalls: [
      {
        id: crypto.randomUUID(),
        type: 'function',
        function: { name: 'noop', arguments: args },
      },
    ],
    finishReason: 'tool_calls',
  };
}

describe('runLoop limits', () => {
  it('treats reordered JSON args as the same repeated call', async () => {
    const tools = createToolRegistry([noop]);
    let calls = 0;
    const modelCall: ModelCallFn = async () => {
      calls += 1;
      if (calls <= 3) {
        const args =
          calls % 2 === 1
            ? '{"b":1,"a":2}'
            : '{"a":2,"b":1}';
        return toolTurn(args);
      }
      return { content: 'done', toolCalls: [], finishReason: 'stop' };
    };
    const messages: ChatCompletionMessageParam[] = [
      { role: 'user', content: 'go' },
    ];
    const result = await runLoop(modelCall, messages, tools, {
      model: 'test',
      streaming: false,
      mode: 'home',
      limits: {
        maxIterations: 8,
        maxToolCalls: 20,
        maxRepeatedToolCalls: 2,
        toolTimeoutMs: 5_000,
      },
    });
    expect(result.status).toBe('incomplete');
    expect(calls).toBeGreaterThan(3);
  });

  it('returns incomplete on a non-stop finish without tools', async () => {
    const tools = createToolRegistry([]);
    const modelCall: ModelCallFn = async () => ({
      content: 'truncated',
      toolCalls: [],
      finishReason: 'length',
    });
    const result = await runLoop(
      modelCall,
      [{ role: 'user', content: 'go' }],
      tools,
      {
        model: 'test',
        streaming: false,
        mode: 'home',
      },
    );
    expect(result.status).toBe('incomplete');
    expect(result.content).toBe('truncated');
  });
});

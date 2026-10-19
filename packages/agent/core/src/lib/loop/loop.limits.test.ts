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
          mode: 'home',
      },
    );
    expect(result.status).toBe('incomplete');
    expect(result.content).toBe('truncated');
  });

  it('nudges once then finishes incomplete while a final plan has open todos', async () => {
    const tools = createToolRegistry([]);
    const seen: string[] = [];
    const modelCall: ModelCallFn = async (_model, messages) => {
      const last = messages.at(-1);
      seen.push(typeof last?.content === 'string' ? last.content : '');
      return { content: 'working', toolCalls: [], finishReason: 'stop' };
    };
    const result = await runLoop(
      modelCall,
      [{ role: 'user', content: 'implement' }],
      tools,
      {
        model: 'test',
          mode: 'workspace',
        hasOpenPlanWork: () => true,
        limits: { maxIterations: 8, toolTimeoutMs: 5_000 },
      },
    );
    expect(result.status).toBe('incomplete');
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatch(/Open todos remain/);
  });

  it('completes when open plan work is cleared after the nudge', async () => {
    const tools = createToolRegistry([]);
    let open = true;
    const modelCall: ModelCallFn = async (_model, messages) => {
      const last = messages.at(-1);
      if (
        typeof last?.content === 'string' &&
        last.content.includes('Open todos remain')
      ) {
        open = false;
      }
      return { content: 'done', toolCalls: [], finishReason: 'stop' };
    };
    const result = await runLoop(
      modelCall,
      [{ role: 'user', content: 'implement' }],
      tools,
      {
        model: 'test',
          mode: 'workspace',
        hasOpenPlanWork: () => open,
        limits: { maxIterations: 8, toolTimeoutMs: 5_000 },
      },
    );
    expect(result.status).toBe('completed');
  });

  it('runs consecutive read-only tools in parallel', async () => {
    const started: number[] = [];
    const delayed = (name: string): Tool => ({
      definition: {
        type: 'function',
        function: {
          name,
          description: 'test',
          parameters: { type: 'object', properties: {} },
        },
      },
      guidance: {
        whenToUse: ['test'],
        whenNotToUse: ['never'],
        usage: ['call'],
      },
      risk: 'read',
      execute: async () => {
        started.push(Date.now());
        await new Promise((resolve) => setTimeout(resolve, 80));
        return name;
      },
    });
    const tools = createToolRegistry([delayed('read_a'), delayed('read_b')]);
    let calls = 0;
    const modelCall: ModelCallFn = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: '1',
              type: 'function',
              function: { name: 'read_a', arguments: '{}' },
            },
            {
              id: '2',
              type: 'function',
              function: { name: 'read_b', arguments: '{}' },
            },
          ],
          finishReason: 'tool_calls',
        };
      }
      return { content: 'done', toolCalls: [], finishReason: 'stop' };
    };
    const t0 = Date.now();
    const result = await runLoop(
      modelCall,
      [{ role: 'user', content: 'look' }],
      tools,
      {
        model: 'test',
          mode: 'workspace',
        limits: { maxIterations: 6, toolTimeoutMs: 5_000 },
      },
    );
    const elapsed = Date.now() - t0;
    expect(result.status).toBe('completed');
    expect(started).toHaveLength(2);
    expect(Math.abs(started[0]! - started[1]!)).toBeLessThan(40);
    expect(elapsed).toBeLessThan(200);
  });
});

import { describe, expect, it } from 'vitest';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { runLoop } from './loop';
import { createToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';
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
    expect(result.limitReason).toMatch(/^limit\.finish:/);
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
    expect(result.limitReason).toMatch(/^limit\.plan:/);
  });

  it('halts edit_file stuck on same path with identical results despite varied args', async () => {
    const editFile: Tool = {
      definition: {
        type: 'function',
        function: {
          name: 'edit_file',
          description: 'test',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
              oldText: { type: 'string' },
              newText: { type: 'string' },
            },
          },
        },
      },
      guidance: {
        whenToUse: ['test'],
        whenNotToUse: ['never'],
        usage: ['call'],
      },
      execute: async () => 'edit_file failed: oldText not found',
    };
    const tools = createToolRegistry([editFile]);
    let calls = 0;
    const modelCall: ModelCallFn = async () => {
      calls += 1;
      if (calls <= 5) {
        return {
          content: '',
          toolCalls: [
            {
              id: `e${calls}`,
              type: 'function',
              function: {
                name: 'edit_file',
                arguments: JSON.stringify({
                  path: 'src/a.ts',
                  oldText: `old-${calls}`,
                  newText: `new-${calls}`,
                }),
              },
            },
          ],
          finishReason: 'tool_calls',
        };
      }
      return { content: 'done', toolCalls: [], finishReason: 'stop' };
    };
    const result = await runLoop(
      modelCall,
      [{ role: 'user', content: 'fix' }],
      tools,
      {
        model: 'test',
        mode: 'workspace',
        limits: {
          maxIterations: 20,
          maxToolCalls: 100,
          maxRepeatedToolCalls: 10,
          toolTimeoutMs: 5_000,
        },
      },
    );
    expect(result.status).toBe('incomplete');
    expect(result.limitReason).toMatch(/^limit\.outcome:/);
    expect(calls).toBeLessThan(5);
  });

  it('resets unknown-tool streak after a valid tool call', async () => {
    const tools = createToolRegistry([noop]);
    let calls = 0;
    const modelCall: ModelCallFn = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'u1',
              type: 'function',
              function: { name: 'invented_a', arguments: '{}' },
            },
          ],
          finishReason: 'tool_calls',
        };
      }
      if (calls === 2) {
        return toolTurn('{}');
      }
      if (calls === 3) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'u2',
              type: 'function',
              function: { name: 'invented_b', arguments: '{}' },
            },
          ],
          finishReason: 'tool_calls',
        };
      }
      return { content: 'done', toolCalls: [], finishReason: 'stop' };
    };
    const result = await runLoop(
      modelCall,
      [{ role: 'user', content: 'go' }],
      tools,
      {
        model: 'test',
        mode: 'home',
        limits: {
          maxIterations: 10,
          maxToolCalls: 20,
          maxRepeatedToolCalls: 5,
          toolTimeoutMs: 5_000,
        },
      },
    );
    expect(result.status).toBe('completed');
    expect(result.limitReason).toBeUndefined();
  });

  it('counts ./path and path as the same read_file storm bucket', async () => {
    const readFile: Tool = {
      definition: {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'test',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
          },
        },
      },
      guidance: {
        whenToUse: ['test'],
        whenNotToUse: ['never'],
        usage: ['call'],
      },
      risk: 'read',
      stage: 'read',
      execute: async () => 'file contents',
    };
    const tools = createToolRegistry([readFile]);
    let calls = 0;
    const modelCall: ModelCallFn = async () => {
      calls += 1;
      const pathArg = calls % 2 === 1 ? 'a.ts' : './a.ts';
      return {
        content: '',
        toolCalls: [
          {
            id: `r${calls}`,
            type: 'function',
            function: {
              name: 'read_file',
              arguments: JSON.stringify({ path: pathArg }),
            },
          },
        ],
        finishReason: 'tool_calls',
      };
    };
    const result = await runLoop(
      modelCall,
      [{ role: 'user', content: 'read' }],
      tools,
      {
        model: 'test',
        mode: 'workspace',
        limits: {
          maxIterations: 80,
          maxToolCalls: 200,
          maxRepeatedToolCalls: 200,
          toolTimeoutMs: 5_000,
        },
      },
    );
    expect(result.status).toBe('incomplete');
    expect(result.limitReason).toMatch(/^limit\.read_storm:/);
    // Shared bucket: ~30 admits then halt — not ~60 if ./a and a split.
    expect(calls).toBeGreaterThan(30);
    expect(calls).toBeLessThan(40);
  });

  it('labels max iterations with limit.iterations', async () => {
    const tools = createToolRegistry([noop]);
    let n = 0;
    const modelCall: ModelCallFn = async () => {
      n += 1;
      return {
        content: '',
        toolCalls: [
          {
            id: `i${n}`,
            type: 'function',
            function: {
              name: 'noop',
              arguments: JSON.stringify({ n }),
            },
          },
        ],
        finishReason: 'tool_calls',
      };
    };
    const result = await runLoop(
      modelCall,
      [{ role: 'user', content: 'go' }],
      tools,
      {
        model: 'test',
        mode: 'home',
        limits: {
          maxIterations: 2,
          maxToolCalls: 100,
          maxRepeatedToolCalls: 10,
          toolTimeoutMs: 5_000,
        },
      },
    );
    expect(result.status).toBe('incomplete');
    expect(result.limitReason).toMatch(/^limit\.iterations:/);
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
});

describe('repeated reads are answered, not fatal', () => {
  const read: Tool = { ...noop, definition: { ...noop.definition, function: { ...noop.definition.function, name: 'read_file' } }, stage: 'read', execute: async () => '[lines 1–1 of 1]\nx' };
  const edit: Tool = { ...noop, definition: { ...noop.definition, function: { ...noop.definition.function, name: 'edit_file' } }, stage: 'mutate', execute: async () => 'Patched a.ts' };
  const call = (name: string): Awaited<ReturnType<ModelCallFn>> => ({
    content: '',
    toolCalls: [{ id: crypto.randomUUID(), type: 'function', function: { name, arguments: '{"path":"a.ts"}' } }],
    finishReason: 'tool_calls',
  });

  async function run(script: string[]) {
    const results: string[] = [];
    const trace: { type: string; kind?: string; reason?: string }[] = [];
    let n = 0;
    const result = await runLoop(
      async () => (n < script.length ? call(script[n++]!) : { content: 'done', toolCalls: [], finishReason: 'stop' }),
      [{ role: 'user', content: 'go' }],
      createToolRegistry([read, edit]),
      {
        model: 'test',
        mode: 'workspace',
        limits: { maxIterations: 20, maxToolCalls: 20, maxRepeatedToolCalls: 2, toolTimeoutMs: 5_000 },
        trace: (event) => trace.push(event as never),
        onMessage: (record) => {
          if (record.role === 'tool') results.push(String(record.content));
        },
      },
    );
    return { result, results, trace };
  }

  it('answers a repeat past the limit and lets the run finish', async () => {
    const { result, results, trace } = await run(['read_file', 'read_file', 'read_file']);
    expect(result.status).toBe('completed');
    expect(results.at(-1)).toMatch(/^Not run again: this exact call already ran 2 time\(s\)/);
    expect(trace.some((event) => event.type === 'policy_decision' && event.kind === 'guard')).toBe(true);
  });

  it('still stops a model that keeps repeating past twice the limit', async () => {
    const { result } = await run(['read_file', 'read_file', 'read_file', 'read_file', 'read_file']);
    expect(result.status).toBe('incomplete');
    expect(result.limitReason).toMatch(/^limit\.repeat/);
  });

  it('a successful edit makes the next read a fresh call, not a repeat', async () => {
    const { result, results } = await run(['read_file', 'read_file', 'edit_file', 'read_file', 'read_file']);
    expect(result.status).toBe('completed');
    expect(results.filter((text) => text.startsWith('Not run again'))).toHaveLength(0);
  });
});

describe('runLoop tool-call cap without a report tool', () => {
  it('a parent run halts at maxToolCalls mid-batch, with no report-only refusals', async () => {
    const tools = createToolRegistry([noop]);
    const results: string[] = [];
    const trace: { type: string; ids?: string[] }[] = [];
    const lastMessages: ChatCompletionMessageParam[][] = [];
    let n = 0;
    const modelCall: ModelCallFn = async (_model, messages, registry) => {
      lastMessages.push([...messages]);
      if (registry.definitions.length === 0) {
        return { content: 'handoff', toolCalls: [], finishReason: 'stop' };
      }
      n += 1;
      return {
        content: '',
        toolCalls: [0, 1, 2].map((i) => ({
          id: `c${n}-${i}`,
          type: 'function' as const,
          function: { name: 'noop', arguments: JSON.stringify({ n, i }) },
        })),
        finishReason: 'tool_calls',
      };
    };
    const result = await runLoop(modelCall, [{ role: 'user', content: 'go' }], tools, {
      model: 'test',
      mode: 'home',
      limits: { maxIterations: 20, maxToolCalls: 5, maxRepeatedToolCalls: 2, toolTimeoutMs: 5_000 },
      trace: (event) => trace.push(event as never),
      onMessage: (record) => {
        if (record.role === 'tool') results.push(String(record.content));
      },
    });
    expect(result.status).toBe('incomplete');
    expect(result.limitReason).toMatch(/^limit\.tools: max tool calls exceeded \(5\)/);
    expect(result.toolCalls).toBe(5);
    // Second turn: two calls run, the third trips the cap and is skipped.
    expect(n).toBe(2);
    expect(results.filter((text) => text.includes('Skipped: tool call limit reached'))).toHaveLength(1);
    expect(results.some((text) => text.includes('only `report` is available'))).toBe(false);
    expect(trace.some((event) => event.ids?.some((id) => id.startsWith('report_only:')))).toBe(false);
    // The parent keeps the plain handoff instruction.
    const instruction = String(lastMessages.at(-1)?.at(-1)?.content ?? '');
    expect(instruction).toContain('This run stopped at a limit; tools are off. If the request can be answered');
  });
});

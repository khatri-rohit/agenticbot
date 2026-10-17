import { describe, expect, it, vi } from 'vitest';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type { LedgerRecord, PendingToolCall, ToolContext } from '@org/agent-models';

import { runLoop } from './loop';
import type { ModelCallFn } from './types';
import type { Tool, ToolRegistry } from '../tools/type';
import type { ModelTurn } from '../model/types';

function toolRegistry(tools: Tool[]): ToolRegistry {
  return {
    definitions: tools.map((t) => t.definition),
    byName: new Map(tools.map((t) => [t.definition.function.name, t])),
  };
}

describe('runLoop onMessage', () => {
  it('emits assistant+tool_calls then tool results in order', async () => {
    const toolCall: PendingToolCall = {
      id: 'call_1',
      type: 'function',
      function: { name: 'echo', arguments: '{"x":1}' },
    };

    let calls = 0;
    const modelCall: ModelCallFn = async () => {
      calls++;
      if (calls === 1) {
        return {
          content: '',
          toolCalls: [toolCall],
          finishReason: 'tool_calls',
        } satisfies ModelTurn;
      }
      return {
        content: 'done',
        toolCalls: [],
        finishReason: 'stop',
      } satisfies ModelTurn;
    };

    const echo: Tool = {
      definition: {
        type: 'function',
        function: {
          name: 'echo',
          parameters: { type: 'object', properties: {} },
        },
      },
      guidance: { whenToUse: [], whenNotToUse: [], usage: [] },
      execute: async (_args: Record<string, unknown>, _ctx: ToolContext) =>
        'echo-ok',
    };

    const records: LedgerRecord[] = [];
    const messages: ChatCompletionMessageParam[] = [
      { role: 'user', content: 'hi' },
    ];

    const result = await runLoop(modelCall, messages, toolRegistry([echo]), {
      model: 'test-model',
      streaming: false,
      mode: 'research',
      onMessage: (record) => {
        records.push(record);
      },
    });

    expect(result.status).toBe('completed');
    expect(records).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [toolCall],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: 'echo-ok',
      },
      {
        role: 'assistant',
        content: 'done',
      },
    ]);
  });
});

describe('runLoop cancel signal', () => {
  it('aborts an in-flight model call when the signal aborts', async () => {
    const controller = new AbortController();

    const modelCall: ModelCallFn = (_m, _msgs, _tools, _delta, signal) =>
      new Promise<ModelTurn>((_resolve, reject) => {
        const onAbort = () => {
          reject(new Error('Run cancelled'));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });
      });

    const loopPromise = runLoop(
      modelCall,
      [{ role: 'user', content: 'hi' }],
      toolRegistry([]),
      {
        model: 'test-model',
        streaming: false,
        mode: 'research',
        signal: controller.signal,
      },
    );

    await vi.waitFor(() => {
      expect(controller.signal.aborted).toBe(false);
    });

    // Let the model call register its abort listener.
    await Promise.resolve();
    controller.abort(new Error('Run cancelled'));

    const result = await loopPromise;
    expect(result.status).toBe('error');
    expect(result.content).toContain('Run cancelled');
  });

  it('aborts an in-flight tool when the signal aborts', async () => {
    const controller = new AbortController();
    const toolCall: PendingToolCall = {
      id: 'call_1',
      type: 'function',
      function: { name: 'slow', arguments: '{}' },
    };

    const modelCall: ModelCallFn = async () =>
      ({
        content: '',
        toolCalls: [toolCall],
        finishReason: 'tool_calls',
      }) satisfies ModelTurn;

    let toolStarted!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });

    const slow: Tool = {
      definition: {
        type: 'function',
        function: {
          name: 'slow',
          parameters: { type: 'object', properties: {} },
        },
      },
      guidance: { whenToUse: [], whenNotToUse: [], usage: [] },
      execute: async (_args, ctx) => {
        toolStarted();
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => reject(new Error('Run cancelled')),
            { once: true },
          );
        });
        return 'never';
      },
    };

    const loopPromise = runLoop(
      modelCall,
      [{ role: 'user', content: 'hi' }],
      toolRegistry([slow]),
      {
        model: 'test-model',
        streaming: false,
        mode: 'research',
        signal: controller.signal,
        limits: { toolTimeoutMs: 30_000 },
      },
    );

    await toolGate;
    controller.abort(new Error('Run cancelled'));

    const result = await loopPromise;
    expect(result.status).toBe('error');
    expect(result.content).toContain('Run cancelled');
  });

  it('durable rows stay wire-valid when cancelled mid-tool', async () => {
    const controller = new AbortController();
    const toolCalls: PendingToolCall[] = [
      {
        id: 'call_1',
        type: 'function',
        function: { name: 'slow', arguments: '{}' },
      },
      {
        id: 'call_2',
        type: 'function',
        function: { name: 'slow', arguments: '{}' },
      },
    ];

    let modelCalls = 0;
    const modelCall: ModelCallFn = async () => {
      modelCalls++;
      return {
        content: '',
        toolCalls,
        finishReason: 'tool_calls',
      } satisfies ModelTurn;
    };

    let toolStarted!: () => void;
    const toolGate = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });

    const slow: Tool = {
      definition: {
        type: 'function',
        function: {
          name: 'slow',
          parameters: { type: 'object', properties: {} },
        },
      },
      guidance: { whenToUse: [], whenNotToUse: [], usage: [] },
      execute: async (_args, ctx) => {
        toolStarted();
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => reject(new Error('Run cancelled')),
            { once: true },
          );
        });
        return 'never';
      },
    };

    const records: LedgerRecord[] = [];
    const loopPromise = runLoop(
      modelCall,
      [{ role: 'user', content: 'hi' }],
      toolRegistry([slow]),
      {
        model: 'test-model',
        streaming: false,
        mode: 'research',
        signal: controller.signal,
        limits: { toolTimeoutMs: 30_000 },
        onMessage: (record) => {
          records.push(record);
        },
      },
    );

    await toolGate;
    controller.abort(new Error('Run cancelled'));
    await loopPromise;

    // Every requested tool call has a tool row, so a replayed ledger keeps
    // the OpenAI contract (no dangling assistant tool_calls).
    const toolRows = records.filter((r) => r.role === 'tool');
    expect(toolRows).toHaveLength(2);
    const assistant = records.find((r) => r.role === 'assistant');
    expect(
      assistant && 'tool_calls' in assistant ? assistant.tool_calls?.length : 0,
    ).toBe(2);
  });
});

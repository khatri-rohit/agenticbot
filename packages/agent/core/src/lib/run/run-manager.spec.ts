import { describe, expect, it, vi } from 'vitest';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type { ModelTurn } from '@org/agent-models';

import type { ModelCallFn } from '../loop/types';
import type { ToolRegistry } from '../tools/type';
import { RunManager } from './run-manager';

const emptyTools: ToolRegistry = {
  definitions: [],
  byName: new Map(),
};

describe('RunManager.cancel', () => {
  it('aborts the run signal so an in-flight model call rejects', async () => {
    const manager = new RunManager();
    let sawAbort = false;

    const modelCall: ModelCallFn = (_m, _msgs, _tools, _delta, signal) =>
      new Promise<ModelTurn>((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            sawAbort = true;
            reject(new Error('Run cancelled'));
          },
          { once: true },
        );
      });

    const messages: ChatCompletionMessageParam[] = [
      { role: 'user', content: 'hi' },
    ];

    const runId = manager.start({
      threadId: 'thread-1',
      model: 'test-model',
      streaming: false,
      mode: 'research',
      messages,
      tools: emptyTools,
      modelCall,
    });

    // Yield so executeRun registers the model call listener.
    await Promise.resolve();
    await Promise.resolve();

    expect(manager.cancel(runId)).toBe(true);
    expect(manager.get(runId)?.abortController.signal.aborted).toBe(true);

    await vi.waitFor(() => {
      expect(sawAbort).toBe(true);
    });

    expect(manager.isRunning(runId)).toBe(false);
  });
});

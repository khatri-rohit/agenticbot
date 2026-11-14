import { describe, expect, it } from 'vitest';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { emptyRunUsage } from '@agent/agent-models';

import { TaskStateTracker } from '../state/task-state';
import { createToolRegistry } from '../tools/registry';
import { createRunState, type LoopConfig } from './run-state';

function state(messages: ChatCompletionMessageParam[]) {
  const config = {
    model: 'test',
    mode: 'workspace',
    runId: 'r1',
    trace: () => undefined,
    task: new TaskStateTracker(),
  } as unknown as LoopConfig;
  return createRunState(
    async () => ({ content: '', toolCalls: [], finishReason: 'stop' }),
    messages,
    createToolRegistry([]),
    config,
    emptyRunUsage(),
    Date.now(),
  );
}

describe('run state', () => {
  it('keeps the user request of the turn, without the harness context in front of it', () => {
    const s = state([
      { role: 'system', content: 'rules' },
      {
        role: 'user',
        content:
          "[Context from the harness for this message. The user did not write it.]\n\n# Plan\nPhase 1.\n\n[End of harness context. The user's message follows.]\n\ncontinue with phase 3",
      },
    ]);
    expect(s.userRequest).toBe('continue with phase 3');
    // Notes the loop appends later are not the user's request.
    s.messages.push({ role: 'user', content: '[Harness note, not from the user] Open todos remain.' });
    expect(s.userRequest).toBe('continue with phase 3');
  });

  it('a stall note does not count as trouble that raises effort; a budget warning still does', () => {
    const s = state([{ role: 'user', content: 'go' }]);
    s.trace({ type: 'stall_nudge', runId: 'r1', iteration: 3, idleTokens: 300_000, promptTokens: 450_000, limitPromptTokens: 10_000_000 });
    expect(s.turnSignals.nudged).toBe(false);
    s.trace({ type: 'budget_warning', runId: 'r1', iteration: 4, reason: 'prompt tokens', promptTokens: 8_500_000, limitPromptTokens: 10_000_000 });
    expect(s.turnSignals.nudged).toBe(true);
  });
});

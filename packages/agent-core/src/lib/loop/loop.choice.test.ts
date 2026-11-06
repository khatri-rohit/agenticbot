import { describe, expect, it } from 'vitest';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { ChoiceSkipped, type LedgerRecord } from '@agent/agent-models';

import { runLoop } from './loop';
import { createToolRegistry } from '../tools/registry';
import { offer_choice } from '../tools/offer-choice';
import type { Tool, ToolRegistry } from '../tools/types';
import type { ModelCallFn } from './types';

/** Runs in the subagent stage, which starts only after offer_choice's (mutate) stage. */
const laterStageTool: Tool = {
  definition: {
    type: 'function',
    function: { name: 'later', description: 'test', parameters: { type: 'object', properties: {} } },
  },
  guidance: { whenToUse: ['test'], whenNotToUse: ['never'], usage: ['call'] },
  stage: 'subagent',
  execute: async () => 'ran',
};

const choiceArgs = JSON.stringify({
  question: 'Which approach?',
  options: [
    { id: 'a', label: 'Approach A' },
    { id: 'b', label: 'Approach B' },
  ],
});

describe('runLoop deferred choice', () => {
  it('ends a skipped choice with one tools-off summary call, answering every call of the turn', async () => {
    const tools = createToolRegistry([offer_choice, laterStageTool]);
    const calls: { tools: ToolRegistry; messages: ChatCompletionMessageParam[] }[] = [];
    const modelCall: ModelCallFn = async (_model, messages, registry) => {
      calls.push({ tools: registry, messages: [...messages] });
      if (calls.length === 1) {
        return {
          content: '',
          toolCalls: [
            { id: 'choice-1', type: 'function', function: { name: 'offer_choice', arguments: choiceArgs } },
            { id: 'later-1', type: 'function', function: { name: 'later', arguments: '{}' } },
          ],
          finishReason: 'tool_calls',
        };
      }
      return { content: 'Open question: A or B. I recommend A.', toolCalls: [], finishReason: 'stop' };
    };
    const durable: LedgerRecord[] = [];

    const result = await runLoop(modelCall, [{ role: 'user', content: 'do it' }], tools, {
      model: 'test',
      mode: 'workspace',
      offerChoice: async () => {
        throw new ChoiceSkipped();
      },
      onMessage: (record) => {
        durable.push(record);
      },
      limits: { maxIterations: 8, toolTimeoutMs: 5_000 },
    });

    // One more call after the skip, with no tools offered, and the run completes with its text.
    expect(calls).toHaveLength(2);
    expect(calls[1]!.tools.definitions).toHaveLength(0);
    expect(result.status).toBe('completed');
    expect(result.content).toBe('Open question: A or B. I recommend A.');

    // Every tool_call of the turn has a row; the later-stage call never ran.
    const toolRows = durable.filter((record) => record.role === 'tool');
    expect(toolRows.map((row) => row.role === 'tool' && row.tool_call_id).sort()).toEqual(['choice-1', 'later-1']);
    const later = toolRows.find((row) => row.role === 'tool' && row.tool_call_id === 'later-1');
    expect(later?.role === 'tool' && later.content).toMatch(/deferred/);

    // The summary call saw the deferred-choice instruction, but it was never made durable.
    const instruction = calls[1]!.messages.at(-1);
    expect(instruction?.role).toBe('user');
    expect(String(instruction?.content)).toMatch(/skipped your question to decide later/);
    expect(durable.some((record) => record.role === 'user' && String(record.content).includes('decide later'))).toBe(false);
    expect(durable.at(-1)).toMatchObject({ role: 'assistant', content: 'Open question: A or B. I recommend A.' });
  });
});

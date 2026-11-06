import { describe, expect, it } from 'vitest';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { ChoiceSkipped, type TraceEvent } from '@agent/agent-models';

import { runLoop } from './loop';
import { createToolRegistry } from '../tools/registry';
import { offer_choice } from '../tools/offer-choice';
import { editFileTool, runTerminalTool } from '../tools/workspace/tools';
import { sha256Text } from '../tools/web/source';
import type { Tool } from '../tools/types';
import type { ModelCallFn } from './types';

const read: Tool = {
  definition: { type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } } },
  guidance: { whenToUse: ['test'], whenNotToUse: ['never'], usage: ['call'] },
  stage: 'read',
  execute: async () => 'file text',
};

describe('model call recording', () => {
  it('rebuilds every call, including the tools-off final, from its blobs', async () => {
    const blobs = new Map<string, string>();
    const received: ChatCompletionMessageParam[][] = [];
    const modelCall: ModelCallFn = async (_model, messages) => {
      received.push(structuredClone(messages));
      if (received.length === 1) {
        return { content: '', finishReason: 'tool_calls', toolCalls: [{ id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] };
      }
      if (received.length === 2) {
        return {
          content: '',
          finishReason: 'tool_calls',
          toolCalls: [
            {
              id: 'c1',
              type: 'function',
              function: { name: 'offer_choice', arguments: JSON.stringify({ question: 'A or B?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] }) },
            },
          ],
        };
      }
      return { content: 'Pick A or B.', toolCalls: [], finishReason: 'stop' };
    };
    const trace: TraceEvent[] = [];

    await runLoop(modelCall, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }], createToolRegistry([read, offer_choice]), {
      model: 'test',
      mode: 'workspace',
      recordCalls: true,
      putBlob: async (text) => {
        const sha = sha256Text(text);
        blobs.set(sha, text);
        return sha;
      },
      offerChoice: async () => {
        throw new ChoiceSkipped();
      },
      trace: (event) => trace.push(event),
      limits: { maxIterations: 8, toolTimeoutMs: 5_000 },
    });

    const requests = trace.filter((event): event is Extract<TraceEvent, { type: 'llm_request' }> => event.type === 'llm_request');
    expect(requests).toHaveLength(3);
    requests.forEach((request, index) => {
      const rebuilt = request.input!.messages.map((ref) => JSON.parse(blobs.get(ref.sha)!));
      expect(rebuilt).toEqual(received[index]);
    });
    expect(requests[0]!.input!.tools?.names).toEqual(['read_file', 'offer_choice']);
    expect(requests[2]).toMatchObject({ final: true, input: { tools: null } });
    expect(requests[1]!.input!.messages.find((ref) => ref.role === 'tool')?.toolCallId).toBe('r1');

    const responses = trace.filter((event): event is Extract<TraceEvent, { type: 'llm_response' }> => event.type === 'llm_response');
    expect(JSON.parse(blobs.get(responses[2]!.output!.sha)!)).toEqual({ role: 'assistant', content: 'Pick A or B.' });
  });

  it('records nothing without recordCalls', async () => {
    const trace: TraceEvent[] = [];
    await runLoop(async () => ({ content: 'hi', toolCalls: [], finishReason: 'stop' }), [{ role: 'user', content: 'go' }], createToolRegistry([]), {
      model: 'test',
      mode: 'workspace',
      putBlob: async () => 'x',
      trace: (event) => trace.push(event),
    });
    expect(trace.some((event) => 'input' in event || 'output' in event)).toBe(false);
  });
});

describe('Tool.classify', () => {
  it('edit_file: applied or not', () => {
    expect(editFileTool.classify!('Patched a.ts\nuniqueness: ok')).toEqual({ outcome: 'ok' });
    expect(editFileTool.classify!('oldText span not found in a.ts. Re-read the file.')).toEqual({ outcome: 'error' });
  });

  it('run_terminal: exit code, or an error when it never ran to exit', () => {
    expect(runTerminalTool.classify!('cwd: /w\nexit 0\nok')).toEqual({ outcome: 'ok', exitCode: 0 });
    expect(runTerminalTool.classify!('cwd: /w\nexit 1\nFAIL')).toEqual({ outcome: 'ok', exitCode: 1 });
    expect(runTerminalTool.classify!('cwd: /w\nexit timeout\n')).toEqual({ outcome: 'error' });
    expect(runTerminalTool.classify!('Command blocked: use read_file')).toEqual({ outcome: 'error' });
  });
});

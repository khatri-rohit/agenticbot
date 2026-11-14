import { describe, expect, it } from 'vitest';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type { AgentEventWithoutSeq, OllamaModelConfig, TraceEvent } from '@agent/agent-models';

import { runLoop } from './loop';
import { buildEffortPolicy } from '../system1/effort';
import { System1Health } from '../system1/health';
import { createSystem1Port, type System1Port } from '../system1/port';
import { createToolRegistry } from '../tools/registry';
import type { Tool } from '../tools/types';
import type { ModelCallFn, ModelCallOverrides } from './types';

const LEVELS: OllamaModelConfig = {
  model: 'glm-test',
  capabilities: ['tools', 'thinking'],
  contextLength: 128_000,
  thinking: { supported: true, values: ['low', 'medium', 'high'], default: 'medium', mode: 'levels' },
  supportsTools: true,
  supportsVision: false,
};

const readTool: Tool = {
  definition: {
    type: 'function',
    function: { name: 'read_file', description: 'test', parameters: { type: 'object', properties: {} } },
  },
  guidance: { whenToUse: ['test'], whenNotToUse: ['never'], usage: ['call'] },
  execute: async () => 'file contents',
};

/** Three reads, then a final answer; records every call's arguments. */
function scriptedModel(calls: Array<{ lastRole: string | undefined; overrides: ModelCallOverrides | undefined }>): ModelCallFn {
  return async (_model, messages, _tools, _onDelta, _signal, overrides) => {
    calls.push({ lastRole: messages.at(-1)?.role, overrides });
    if (calls.length <= 3) {
      return {
        content: '',
        toolCalls: [
          {
            id: `call-${calls.length}`,
            type: 'function',
            function: { name: 'read_file', arguments: `{"n":${calls.length}}` },
          },
        ],
        finishReason: 'tool_calls',
      };
    }
    return { content: 'done', toolCalls: [], finishReason: 'stop' };
  };
}

async function run(system1: System1Port | undefined, auto: boolean) {
  const calls: Array<{ lastRole: string | undefined; overrides: ModelCallOverrides | undefined }> = [];
  const events: AgentEventWithoutSeq[] = [];
  const traces: TraceEvent[] = [];
  const messages: ChatCompletionMessageParam[] = [{ role: 'user', content: 'read three files' }];
  const result = await runLoop(scriptedModel(calls), messages, createToolRegistry([readTool]), {
    model: 'glm-test',
    mode: 'workspace',
    limits: { maxIterations: 10, toolTimeoutMs: 5_000 },
    effortPolicy: buildEffortPolicy(LEVELS, auto ? 'auto' : 'medium', auto),
    ...(system1 ? { system1 } : {}),
    emit: (event) => events.push(event),
    trace: (event) => traces.push(event),
  });
  return { result, calls, events, traces, messages };
}

function port(mode: 'shadow' | 'enforce', fetchImpl: typeof fetch, timeoutMs = 50): System1Port {
  return createSystem1Port({
    client: { url: 'http://localhost:11434/v1/systemone', model: 'nimble-v3:9b', timeoutMs },
    health: new System1Health(),
    mode,
    runBudgetMs: 10_000,
    fetchImpl,
  });
}

const hang: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
  });
const refuse: typeof fetch = async () => {
  throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
};
const garbage: typeof fetch = async () => new Response('{"answers":{"x":1}}', { status: 200 });
const crash: typeof fetch = () => {
  throw new Error('synchronous crash');
};
const confidentEasy: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  const answers: Record<string, unknown> = {};
  for (const key of Object.keys(body.questions)) answers[key] = { type: 'noul', noul: 0.02 };
  return new Response(JSON.stringify({ model: 'nimble-v3:9b', answers }), { status: 200 });
};

function comparable(outcome: Awaited<ReturnType<typeof run>>) {
  return {
    status: outcome.result.status,
    content: outcome.result.content,
    iterations: outcome.result.iterations,
    toolCalls: outcome.result.toolCalls,
    calls: outcome.calls,
    messages: outcome.messages,
  };
}

describe('runLoop with System 1', () => {
  it.each([
    ['hangs past the timeout', hang],
    ['is unreachable', refuse],
    ['returns garbage', garbage],
    ['throws synchronously', crash],
  ])('runs exactly as without System 1 when it %s, and reports once', async (_label, fetchImpl) => {
    const baseline = await run(undefined, true);
    const degraded = await run(port('enforce', fetchImpl), true);
    expect(comparable(degraded)).toEqual(comparable(baseline));
    const reports = degraded.events.filter((event) => event.type === 'system1.report');
    expect(reports).toHaveLength(1);
    expect(degraded.traces.filter((event) => event.type === 'system1_report')).toHaveLength(1);
  });

  it('sends nothing different in shadow mode, even with confident scores', async () => {
    const baseline = await run(undefined, false);
    const shadow = await run(port('shadow', confidentEasy), false);
    expect(comparable(shadow)).toEqual(comparable(baseline));
    expect(shadow.events.some((event) => event.type === 'system1.report')).toBe(false);
    expect(shadow.traces.some((event) => event.type === 'system1_decision')).toBe(true);
  });

  it('lowers effort in enforce only after two quiet steps, never on the first turn, and not while nothing progresses', async () => {
    const enforced = await run(port('enforce', confidentEasy), true);
    expect(enforced.result.status).toBe('completed');
    // 1: first turn (floor). 2: first eligible lower (pending). 3: lowered.
    // 4: three steps with no evidence (this script records none): the floor
    // holds the baseline again (F-4).
    expect(enforced.calls.map((call) => call.overrides?.reasoningEffort)).toEqual([
      undefined,
      undefined,
      'low',
      undefined,
    ]);
    const requests = enforced.traces.filter((event) => event.type === 'llm_request');
    expect(requests.map((event) => (event as { reasoningEffort?: string }).reasoningEffort)).toEqual([
      'medium',
      'medium',
      'low',
      'medium',
    ]);
    expect(enforced.traces).toContainEqual(
      expect.objectContaining({ type: 'policy_decision', kind: 'effort', ids: ['effort_floor:no_progress'], iteration: 4 }),
    );
  });
});

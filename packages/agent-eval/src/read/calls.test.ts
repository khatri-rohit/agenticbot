import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { listCalls, readCall } from './calls.js';
import { summarizeRun } from './runs.js';
import { parseTrace } from './trace.js';

const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** A thread with one recorded run: two tool-using calls and a tools-off final call. */
async function fixture(options: { rewound?: boolean } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'agent-eval-calls-'));
  const thread = path.join(home, 'sessions', 't1');
  await mkdir(path.join(thread, 'traces'), { recursive: true });
  await mkdir(path.join(thread, 'blobs'), { recursive: true });
  const blob = async (value: unknown) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    await writeFile(path.join(thread, 'blobs', sha(text)), text);
    return sha(text);
  };
  const ref = async (message: { role: string; content: string | null; tool_call_id?: string; tool_calls?: unknown[] }) => ({
    role: message.role,
    sha: await blob(message),
    chars: (message.content ?? '').length,
    ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
  });

  const system = { role: 'system', content: 'You are an agent.' };
  const user = { role: 'user', content: 'Fix the bug.' };
  const assistant = { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] };
  const fullResult = 'line\n'.repeat(400);
  const toolFull = { role: 'tool', content: fullResult, tool_call_id: 'c1' };
  const toolStub = { role: 'tool', content: '(stub: read_file a.ts, 400 lines)', tool_call_id: 'c1' };
  const injected = { role: 'user', content: 'This run stopped at a limit; tools are off.' };
  const tools = [{ type: 'function', function: { name: 'read_file' } }];
  const toolsSha = await blob(tools);
  const answer = { role: 'assistant', content: 'Handoff: read a.ts.' };

  const lines = [
    { seq: 1, type: 'run_start', runId: 'r1', model: 'm' },
    { seq: 2, type: 'llm_request', runId: 'r1', iteration: 1, input: { messages: [await ref(system), await ref(user)], tools: { sha: toolsSha, names: ['read_file'] } } },
    { seq: 3, type: 'llm_response', runId: 'r1', iteration: 1, finishReason: 'tool_calls', hasToolCalls: true, usage: { promptTokens: 100, completionTokens: 5 }, output: { sha: await blob(assistant) } },
    { seq: 4, type: 'llm_request', runId: 'r1', iteration: 2, input: { messages: [await ref(system), await ref(user), await ref(assistant), await ref(toolFull)], tools: { sha: toolsSha, names: ['read_file'] } } },
    { seq: 5, type: 'llm_response', runId: 'r1', iteration: 2, finishReason: 'stop', hasToolCalls: false, usage: { promptTokens: 600, completionTokens: 5 } },
    { seq: 6, type: 'llm_request', runId: 'r1', iteration: 2, final: true, input: { messages: [await ref(system), await ref(user), await ref(assistant), await ref(toolStub), await ref(injected)], tools: null } },
    { seq: 7, type: 'llm_response', runId: 'r1', iteration: 2, final: true, finishReason: 'stop', hasToolCalls: false, usage: { promptTokens: 150, completionTokens: 9 }, output: { sha: await blob(answer) } },
    { seq: 8, type: 'run_finish', runId: 'r1', iterations: 2, toolCalls: 1, status: 'incomplete' },
  ];
  const tracePath = path.join(thread, 'traces', 'r1.jsonl');
  await writeFile(tracePath, lines.map((line) => JSON.stringify(line)).join('\n'));
  const ledger = options.rewound
    ? []
    : [
        { v: 1, seq: 1, ts: '', threadId: 't1', runId: 'r1', record: user },
        { v: 1, seq: 2, ts: '', threadId: 't1', runId: 'r1', record: assistant },
        { v: 1, seq: 3, ts: '', threadId: 't1', runId: 'r1', record: { ...toolFull, content: `(full result in blob sha256:${sha(fullResult)})` }, contentBlob: await blob(fullResult) },
      ];
  await writeFile(path.join(thread, 'ledger.jsonl'), ledger.map((row) => JSON.stringify(row)).join('\n'));
  const run = summarizeRun({ runId: 'r1', threadId: 't1', tracePath, lines: parseTrace(lines.map((l) => JSON.stringify(l)).join('\n')).lines, warnings: 0 });
  return { home, run, lines };
}

describe('listCalls', () => {
  it('lists every call, the tools-off final included', async () => {
    const { lines } = await fixture();
    const calls = listCalls(parseTrace(lines.map((l) => JSON.stringify(l)).join('\n')).lines);
    expect(calls.map((c) => [c.index, c.iteration, c.final, c.promptTokens])).toEqual([
      [1, 1, false, 100],
      [2, 2, false, 600],
      [3, 2, true, 150],
    ]);
    expect(calls.every((c) => c.recorded)).toBe(true);
  });
});

describe('readCall', () => {
  it('rebuilds a call: kinds, stubbed tool result, injected note, tools and diff', async () => {
    const { home, run } = await fixture();
    const second = (await readCall(home, run, 2))!;
    expect(second.input.map((m) => m.kind)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(second.input[2]!.toolCalls).toEqual([{ id: 'c1', name: 'read_file', args: '{"path":"a.ts"}' }]);
    expect(second.input[3]!.stub).toBeUndefined();
    expect(second.input.filter((m) => m.added).map((m) => m.index)).toEqual([2, 3]);
    expect(second.tools?.names).toEqual(['read_file']);

    const final = (await readCall(home, run, 3))!;
    expect(final.call.final).toBe(true);
    expect(final.tools).toBeNull();
    expect(final.input.map((m) => m.kind)).toEqual(['system', 'user', 'assistant', 'tool', 'injected']);
    expect(final.input[3]!.stub).toBe(true);
    expect(final.removed).toBe(1);
    expect(final.output?.text).toBe('Handoff: read a.ts.');
    expect(final.ledger).toBe('matched');
    expect(final.tokensByKind.injected).toBeGreaterThan(0);
  });

  it('labels nothing injected when the run was rewound out of the ledger', async () => {
    const { home, run } = await fixture({ rewound: true });
    const final = (await readCall(home, run, 3))!;
    expect(final.ledger).toBe('rewound');
    expect(final.input.some((m) => m.kind === 'injected')).toBe(false);
  });

  it('returns null for a call the run never made', async () => {
    const { home, run } = await fixture();
    expect(await readCall(home, run, 9)).toBeNull();
  });
});

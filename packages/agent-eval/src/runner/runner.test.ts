import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { lastRunFrom, type RunOutcome, type ThreadLastRun } from '@agent/agent-models';

import { summarizeSuite } from '../gate/summary.js';
import { ApiClient } from './api-client.js';
import { isTrialDir } from './checkout.js';
import { git } from './exec.js';
import { runTrial, type TrialClient, type TrialResult } from './runner.js';
import type { LoadedTask } from './task.js';

/** One scripted run: what the "agent" writes into the workspace, and how the run ends. */
type ScriptedRun = {
  edit?: { file: string; text: string };
  outcome?: RunOutcome;
  limitReason?: string;
  promptTokens?: number;
  /** settledLastRun answers null this many times first (a run still going past the deadline). */
  liveFor?: number;
};

/** The trial's API, scripted: writes workspace edits and trace files the way a real run would. */
class FakeAgent implements TrialClient {
  workspace = '';
  cancelled: string[] = [];
  private runs = new Map<string, ScriptedRun>();
  private count = 0;

  constructor(
    private readonly home: string,
    private readonly script: ScriptedRun[],
  ) {}

  async createThread(input: { workspaceRoot: string }): Promise<{ id: string }> {
    this.workspace = input.workspaceRoot;
    return { id: 'thread-1' };
  }

  async startRun(): Promise<{ runId: string }> {
    const step = this.script[this.count] ?? { outcome: 'completed' };
    const runId = `run-${++this.count}`;
    this.runs.set(runId, { ...step });
    if (step.edit) await writeFile(path.join(this.workspace, step.edit.file), step.edit.text);
    const traces = path.join(this.home, 'sessions', 'thread-1', 'traces');
    await mkdir(traces, { recursive: true });
    const usage = {
      own: { promptTokens: step.promptTokens ?? 1000, completionTokens: 10, calls: 1, estimatedCalls: 0 },
      children: { promptTokens: 0, completionTokens: 0, calls: 0, estimatedCalls: 0 },
    };
    const lines = [
      { seq: 1, ts: new Date().toISOString(), type: 'run_start', runId, model: 'm' },
      { seq: 2, type: 'llm_response', runId, iteration: 1, finishReason: 'stop', hasToolCalls: false, usage: { promptTokens: step.promptTokens ?? 1000, completionTokens: 10 } },
      {
        seq: 3,
        ts: new Date().toISOString(),
        type: 'run_finish',
        runId,
        iterations: 1,
        toolCalls: 0,
        status: step.outcome === 'incomplete' ? 'incomplete' : 'completed',
        ...(step.limitReason ? { limitReason: step.limitReason } : {}),
        usage,
      },
    ];
    await writeFile(path.join(traces, `${runId}.jsonl`), lines.map((line) => JSON.stringify(line)).join('\n'));
    return { runId };
  }

  async cancelRun(runId: string): Promise<void> {
    this.cancelled.push(runId);
  }

  async settledLastRun(_threadId: string, runId: string): Promise<ThreadLastRun | null> {
    const run = this.runs.get(runId)!;
    if ((run.liveFor ?? 0) > 0) {
      run.liveFor! -= 1;
      return null;
    }
    return lastRunFrom({
      runId,
      outcome: run.outcome ?? 'completed',
      iterations: 1,
      toolCalls: 0,
      ...(run.limitReason ? { limitReason: run.limitReason } : {}),
    });
  }
}

let source = '';
let commit = '';
let scratch = '';

beforeAll(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'agent-eval-runner-'));
  // A throwaway source repo in the OS temp folder for the trial checkout.
  source = path.join(scratch, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'README.md'), '# Demo\n');
  for (const args of [
    ['init', '--quiet'],
    ['add', '.'],
    ['-c', 'user.email=eval@test', '-c', 'user.name=eval', 'commit', '--quiet', '-m', 'init'],
  ]) {
    const out = await git(source, args);
    if (out.code !== 0) throw new Error(out.out);
  }
  commit = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim();
}, 60_000);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

function task(overrides: Partial<LoadedTask['task']> = {}): LoadedTask {
  return {
    file: 'demo.json',
    taskHash: 'h',
    task: {
      id: 'demo',
      suite: 'regression',
      repo: { source, commit },
      prompt: 'Add a glossary.',
      posture: 'agent',
      checks: [],
      files: [{ path: 'README.md', mustMatch: '^## Glossary$' }],
      scope: { allow: ['README.md'] },
      budget: { maxPromptTokens: 100_000, maxMinutes: 5 },
      ...overrides,
    },
  };
}

let trialNumber = 0;
async function trial(script: ScriptedRun[], loaded = task()): Promise<{ result: TrialResult; agent: FakeAgent }> {
  const home = await mkdtemp(path.join(scratch, 'home-'));
  const agent = new FakeAgent(home, script);
  const result = await runTrial(
    agent,
    { evalHome: home, harnessRoot: scratch, model: 'm', continues: 2 },
    loaded,
    ++trialNumber,
    { harnessSha: 'sha', harnessDirty: null, seedHash: 'seed', model: 'm' },
  );
  return { result, agent };
}

const glossary = { file: 'README.md', text: '# Demo\n\n## Glossary\n' };
/** A deadline already behind us (budget minutes × 2 + 10 minutes < 0). */
const pastDeadline = () => task({ budget: { maxPromptTokens: 100_000, maxMinutes: -5.1 } });

describe('runTrial', () => {
  it('grades a run that completes the first time', async () => {
    const { result } = await trial([{ edit: glossary, promptTokens: 1234 }]);
    expect(result).toMatchObject({ status: 'passed', ended: 'settled', continues: 0, promptTokens: 1234 });
  }, 60_000);

  it('continues after a resumable stop', async () => {
    const { result } = await trial([
      { outcome: 'incomplete', limitReason: 'limit.tokens: over budget' },
      { edit: glossary },
    ]);
    expect(result).toMatchObject({ status: 'passed', continues: 1 });
    expect(result.runIds).toHaveLength(2);
  }, 60_000);

  it('skips the trial when the account runs out', async () => {
    const { result } = await trial([{ outcome: 'incomplete', limitReason: 'limit.capacity: weekly allowance spent' }]);
    expect(result).toMatchObject({ status: 'skipped', ended: 'capacity', continues: 0 });
    expect(result.grade).toBeUndefined();
  }, 60_000);

  it('cancels a run past its deadline and grades it once it settled', async () => {
    const { result, agent } = await trial([{ edit: glossary, liveFor: 1 }], pastDeadline());
    expect(agent.cancelled).toEqual(['run-1']);
    expect(result).toMatchObject({ status: 'failed', ended: 'timeout', limitReason: 'eval.timeout: trial passed its hard deadline' });
    expect(result.grade?.filesPassed).toBe(true);
  }, 60_000);

  it('does not grade a run that never settles after its cancel', async () => {
    const { result } = await trial([{ edit: glossary, liveFor: 2 }], pastDeadline());
    expect(result).toMatchObject({ status: 'error', ended: 'error' });
    expect(result.reason).toMatch(/did not settle/);
    expect(result.grade).toBeUndefined();
  }, 60_000);

  it('cancels a run past twice its token budget', async () => {
    const { result, agent } = await trial([{ edit: glossary, liveFor: 1, promptTokens: 250_000 }]);
    expect(agent.cancelled).toEqual(['run-1']);
    expect(result).toMatchObject({ status: 'failed', ended: 'over-budget' });
    expect(result.limitReason).toMatch(/^eval\.budget:/);
  }, 60_000);

  it('marks a run the server lost as an error, not a normal end', async () => {
    const { result } = await trial([{ edit: glossary, outcome: 'interrupted' }]);
    expect(result.ended).toBe('error');
  }, 60_000);

  it('fails a trial that edits outside its scope', async () => {
    const { result } = await trial([{ edit: { file: 'OTHER.md', text: 'x' } }]);
    expect(result.status).toBe('failed');
    expect(result.scopeViolations).toEqual(['OTHER.md']);
  }, 60_000);
});

describe('ApiClient.settledLastRun', () => {
  it('skips a pending choice, then returns the run once it settled, never another run', async () => {
    const posted: { url: string; body: unknown }[] = [];
    const replies = [
      { lastRun: lastRunFrom({ runId: 'old', outcome: 'completed', iterations: 1, toolCalls: 0 }) },
      { activeRun: { runId: 'r1', model: 'm', posture: 'agent', startedAt: '', pendingChoices: [{ choiceId: 'c1', question: 'q', options: [] }] } },
      { lastRun: lastRunFrom({ runId: 'r1', outcome: 'completed', iterations: 2, toolCalls: 1 }) },
    ];
    const fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        posted.push({ url, body: JSON.parse(init.body ?? '{}') });
        return new Response('{}');
      }
      return new Response(JSON.stringify({ messages: [], lastSeq: 0, snapshot: null, plan: null, ...replies.shift() }));
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const lastRun = await new ApiClient('http://api', 1).settledLastRun('t1', 'r1', 5_000);
      expect(lastRun?.runId).toBe('r1');
      expect(posted).toEqual([{ url: 'http://api/run/r1/choice', body: { choiceId: 'c1', skipped: true } }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('workdirs and suites', () => {
  it('prunes only this task’s trial folders', () => {
    expect(isTrialDir('readme-2', 'readme')).toBe(true);
    expect(isTrialDir('readme-glossary-1', 'readme')).toBe(false);
  });

  it('refuses to summarize trials from mixed suites', () => {
    const base = { harnessSha: 's', harnessDirty: null, seedHash: 'x', model: 'm', taskHash: 'h', continues: 0, runIds: [], startedAt: '', finishedAt: '', status: 'passed' as const };
    expect(() =>
      summarizeSuite([
        { ...base, taskId: 'a', trial: 1, suite: 'regression' },
        { ...base, taskId: 'b', trial: 1, suite: 'capability' },
      ]),
    ).toThrow(/suite/);
  });
});

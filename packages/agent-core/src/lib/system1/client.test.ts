import { describe, expect, it } from 'vitest';

import type { System1Question } from '@agent/agent-models';

import { callSystem1, parseSystem1Response } from './client';
import { System1Health } from './health';
import { createSystem1Port } from './port';

const QUESTIONS: Record<string, System1Question> = {
  says_hello: {
    type: 'noul',
    instructions: 'Is this an introduction?',
    criteria: { true: 'yes', false: 'no' },
  },
};
const CONFIG = { url: 'http://localhost:11434/v1/systemone', model: 'nimble-v3:9b', timeoutMs: 100 };

function respond(status: number, body: unknown): typeof fetch {
  return async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

const OK_BODY = {
  model: 'nimble-v3:9b',
  answers: { says_hello: { type: 'noul', noul: 0.98 } },
  usage: { input_tokens: 191, output_tokens: 0 },
};

describe('parseSystem1Response', () => {
  it('accepts the observed response shape', () => {
    expect(parseSystem1Response(OK_BODY, QUESTIONS, 'nimble-v3:9b')).toEqual({
      ok: true,
      scores: { says_hello: 0.98 },
    });
  });

  it.each([
    ['not an object', 'x'],
    ['model mismatch', { ...OK_BODY, model: 'other:1b' }],
    ['no answers', { model: 'nimble-v3:9b' }],
    ['missing key', { model: 'nimble-v3:9b', answers: {} }],
    ['wrong type', { model: 'nimble-v3:9b', answers: { says_hello: { type: 'bool', bool: true } } }],
    ['NaN', { model: 'nimble-v3:9b', answers: { says_hello: { type: 'noul', noul: Number.NaN } } }],
    ['above 1', { model: 'nimble-v3:9b', answers: { says_hello: { type: 'noul', noul: 1.7 } } }],
    ['negative', { model: 'nimble-v3:9b', answers: { says_hello: { type: 'noul', noul: -0.1 } } }],
  ])('rejects %s', (_label, body) => {
    expect(parseSystem1Response(body, QUESTIONS, 'nimble-v3:9b').ok).toBe(false);
  });
});

describe('callSystem1', () => {
  it('returns scores on success', async () => {
    const result = await callSystem1(CONFIG, 'Hi my name is rohit', QUESTIONS, undefined, respond(200, OK_BODY));
    expect(result).toMatchObject({ ok: true, scores: { says_hello: 0.98 } });
  });

  it('classifies HTTP errors, invalid JSON and network failures', async () => {
    expect(await callSystem1(CONFIG, 's', QUESTIONS, undefined, respond(500, 'boom'))).toMatchObject({
      ok: false,
      kind: 'http_error',
    });
    expect(await callSystem1(CONFIG, 's', QUESTIONS, undefined, respond(200, '{nope'))).toMatchObject({
      ok: false,
      kind: 'bad_response',
    });
    const refused: typeof fetch = async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:11434') });
    };
    expect(await callSystem1(CONFIG, 's', QUESTIONS, undefined, refused)).toMatchObject({
      ok: false,
      kind: 'unreachable',
      detail: expect.stringContaining('ECONNREFUSED'),
    });
  });

  it('times out instead of hanging', async () => {
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const result = await callSystem1({ ...CONFIG, timeoutMs: 20 }, 's', QUESTIONS, undefined, hang);
    expect(result).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('reports a run cancel as cancelled, not a failure', async () => {
    const controller = new AbortController();
    const hang: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const pending = callSystem1(CONFIG, 's', QUESTIONS, controller.signal, hang);
    controller.abort();
    expect(await pending).toMatchObject({ ok: false, kind: 'cancelled' });
  });
});

describe('System1Health', () => {
  it('opens after 3 transport failures and half-opens after the cooldown', () => {
    let now = 0;
    const health = new System1Health(
      { failureThreshold: 3, badResponseThreshold: 5, cooldownMs: 1_000, maxInFlight: 2 },
      () => now,
    );
    for (let i = 0; i < 3; i++) {
      expect(health.admit()).toBe(true);
      health.failure();
    }
    expect(health.admit()).toBe(false);
    now = 1_000;
    expect(health.admit()).toBe(true); // the one half-open probe
    expect(health.admit()).toBe(false); // others wait for its verdict
    health.failure();
    expect(health.breakerState).toBe('open');
    now = 2_000;
    expect(health.admit()).toBe(true);
    health.success();
    expect(health.breakerState).toBe('closed');
  });

  it('gives up on a slot after the wait', async () => {
    const health = new System1Health({ failureThreshold: 3, badResponseThreshold: 5, cooldownMs: 1_000, maxInFlight: 1 });
    const release = await health.acquire(10);
    expect(release).not.toBeNull();
    expect(await health.acquire(10)).toBeNull();
    release!();
    expect(await health.acquire(10)).not.toBeNull();
  });
});

describe('createSystem1Port', () => {
  it('never throws and records each fallback once per kind', async () => {
    const health = new System1Health();
    const port = createSystem1Port({
      client: CONFIG,
      health,
      mode: 'shadow',
      runBudgetMs: 10_000,
      fetchImpl: respond(500, 'down'),
    });
    expect(await port.ask('effort', 's', QUESTIONS, { iteration: 2 })).toBeNull();
    expect(await port.ask('effort', 's', QUESTIONS, { iteration: 3 })).toBeNull();
    expect(await port.ask('effort', 's', QUESTIONS, { iteration: 4 })).toBeNull();
    // Breaker is open now: no request, recorded as breaker_open.
    expect(await port.ask('effort', 's', QUESTIONS, { iteration: 5 })).toBeNull();
    const report = port.report()!;
    expect(report.calls).toBe(3);
    expect(report.fallbacks).toEqual([
      expect.objectContaining({ kind: 'http_error', count: 3, firstIteration: 2 }),
      expect.objectContaining({ kind: 'breaker_open', count: 1, firstIteration: 5 }),
    ]);
  });

  it('skips once the run budget is spent', async () => {
    const port = createSystem1Port({
      client: CONFIG,
      health: new System1Health(),
      mode: 'enforce',
      runBudgetMs: 0,
      fetchImpl: respond(200, OK_BODY),
    });
    expect(await port.ask('effort', 's', QUESTIONS, { iteration: 1 })).toBeNull();
    expect(port.report()!.fallbacks[0]!.kind).toBe('budget_exhausted');
  });

  it('reports nothing when never consulted, and nothing for a cancelled run', async () => {
    const controller = new AbortController();
    controller.abort();
    const port = createSystem1Port({
      client: CONFIG,
      health: new System1Health(),
      mode: 'shadow',
      runBudgetMs: 10_000,
      fetchImpl: respond(200, OK_BODY),
    });
    expect(await port.ask('effort', 's', QUESTIONS, { iteration: 1, signal: controller.signal })).toBeNull();
    expect(port.report()).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import type { OllamaModelConfig, System1EffortTrace, ThinkingValue } from '@agent/agent-models';

import {
  buildEffortLadder,
  buildEffortPolicy,
  buildEffortQuestions,
  chooseRung,
  createEffortRouter,
  resolveProfileThinking,
  type EffortSignals,
} from './effort';
import type { System1Port } from './port';

function model(values: ThinkingValue[], fallback: ThinkingValue | null, mode: OllamaModelConfig['thinking']['mode']): OllamaModelConfig {
  return {
    model: 'm',
    capabilities: ['tools', 'thinking'],
    contextLength: 128_000,
    thinking: { supported: mode !== 'none', values, default: fallback, mode },
    supportsTools: true,
    supportsVision: false,
  };
}

const LEVELS = model(['high', 'low', 'medium'], 'medium', 'levels');
const BOOLEAN = model([true, false], true, 'boolean');
const MIXED = model([false, 'low', 'high'], 'high', 'mixed');
const NONE = model([], null, 'none');
const UNKNOWN = model(['low', 'turbo'], 'low', 'levels');

const QUIET: EffortSignals = { iteration: 4, steering: false, toolError: false, wrote: false, idleSteps: 0 };

describe('buildEffortLadder', () => {
  it('orders the model’s own levels, lowest first', () => {
    expect(buildEffortLadder(LEVELS)!.map((rung) => rung.key)).toEqual(['low', 'medium', 'high']);
  });

  it('maps a boolean model to off < on with the wire values the harness already sends', () => {
    expect(buildEffortLadder(BOOLEAN)).toEqual([
      { key: 'off', value: false, wire: 'none' },
      { key: 'on', value: true, wire: 'medium' },
    ]);
  });

  it('puts off at the bottom of a mixed model', () => {
    expect(buildEffortLadder(MIXED)!.map((rung) => rung.wire)).toEqual(['none', 'low', 'high']);
  });

  it('has no ladder for a model without thinking or with an unknown level', () => {
    expect(buildEffortLadder(NONE)).toBeNull();
    expect(buildEffortLadder(UNKNOWN)).toBeNull();
  });
});

describe('buildEffortPolicy', () => {
  it('keeps an explicit pick fixed even when Auto is available', () => {
    expect(buildEffortPolicy(LEVELS, 'low', true)).toMatchObject({ kind: 'fixed', wire: 'low', baselineIndex: 0 });
  });

  it('starts Auto from the model default', () => {
    expect(buildEffortPolicy(LEVELS, 'auto', true)).toMatchObject({ kind: 'auto', baselineIndex: 1 });
  });

  it('falls back to the default when Auto is unavailable', () => {
    expect(buildEffortPolicy(LEVELS, 'auto', false)).toMatchObject({ kind: 'fixed', wire: 'medium' });
  });

  it('passes a model’s own auto level through untouched', () => {
    const ownsAuto = model(['low', 'auto'], 'auto', 'levels');
    expect(buildEffortPolicy(ownsAuto, 'auto', true)).toEqual({ kind: 'fixed', wire: 'auto' });
  });

  it('is fixed with no wire when the model config is unknown', () => {
    expect(buildEffortPolicy(null, 'auto', true)).toEqual({ kind: 'fixed' });
  });
});

describe('resolveProfileThinking', () => {
  it('resolves off / max against the child model’s own values', () => {
    expect(resolveProfileThinking(MIXED, 'off')).toBe(false);
    expect(resolveProfileThinking(LEVELS, 'off')).toBeUndefined();
    expect(resolveProfileThinking(LEVELS, 'max')).toBe('high');
    expect(resolveProfileThinking(BOOLEAN, 'max')).toBe(true);
    expect(resolveProfileThinking(NONE, 'max')).toBeUndefined();
    expect(resolveProfileThinking(LEVELS, 'default')).toBeUndefined();
  });

  it('resolves high to the highest level at or below high, never above it', () => {
    const WITH_MAX = model(['low', 'high', 'max'], 'high', 'levels');
    const NO_HIGH = model(['low', 'medium', 'xhigh', 'max'], 'medium', 'levels');
    const ABOVE_HIGH = model(['xhigh', 'max'], 'xhigh', 'levels');
    expect(resolveProfileThinking(WITH_MAX, 'high')).toBe('high');
    expect(resolveProfileThinking(WITH_MAX, 'max')).toBe('max');
    expect(resolveProfileThinking(NO_HIGH, 'high')).toBe('medium');
    expect(resolveProfileThinking(ABOVE_HIGH, 'high')).toBe('xhigh');
    expect(resolveProfileThinking(MIXED, 'high')).toBe('high');
    expect(resolveProfileThinking(BOOLEAN, 'high')).toBe(true);
    expect(resolveProfileThinking(NONE, 'high')).toBeUndefined();
  });
});


describe('chooseRung', () => {
  const ladder = buildEffortLadder(LEVELS)!;
  const scores = (medium: number, high: number) => ({
    needs_at_least_medium: medium,
    needs_at_least_high: high,
  });

  it('raises at once on moderate confidence', () => {
    expect(chooseRung(ladder, 1, 0, scores(0.9, 0.7), false)).toMatchObject({ index: 2, reason: 'raise' });
  });

  it('lowers only on the second confident call in a row', () => {
    expect(chooseRung(ladder, 1, 0, scores(0.05, 0.01), false)).toMatchObject({ index: 1, reason: 'lower_pending' });
    expect(chooseRung(ladder, 1, 0, scores(0.05, 0.01), true)).toMatchObject({ index: 0, reason: 'lower' });
  });

  it('never lowers below the rules’ floor', () => {
    expect(chooseRung(ladder, 1, 1, scores(0.05, 0.01), true)).toMatchObject({ index: 1, reason: 'keep' });
  });

  it('keeps the baseline on middling scores', () => {
    expect(chooseRung(ladder, 1, 0, scores(0.4, 0.3), true)).toMatchObject({ index: 1, reason: 'keep' });
  });

  it('flags non-monotone scores as inconsistent', () => {
    expect(chooseRung(ladder, 1, 0, scores(0.2, 0.9), false)).toHaveProperty('inconsistent');
  });
});

describe('buildEffortQuestions', () => {
  it('asks one ordinal question per rung above the lowest', () => {
    expect(Object.keys(buildEffortQuestions(buildEffortLadder(MIXED)!))).toEqual([
      'needs_at_least_low',
      'needs_at_least_high',
    ]);
  });
});

function fakePort(mode: 'shadow' | 'enforce', answer: () => Promise<Record<string, number> | null>): System1Port & { notes: string[] } {
  const pending: Promise<unknown>[] = [];
  const notes: string[] = [];
  return {
    mode,
    notes,
    ask: answer,
    note: (_site, kind) => notes.push(kind),
    markApplied: () => undefined,
    track: (work) => pending.push(work),
    settle: async () => {
      await Promise.allSettled(pending);
    },
    report: () => null,
  };
}

describe('createEffortRouter', () => {
  it('applies a raise in enforce mode', async () => {
    const router = createEffortRouter();
    const decision = await router.decide({
      policy: buildEffortPolicy(LEVELS, 'auto', true),
      system1: fakePort('enforce', async () => ({ needs_at_least_medium: 0.95, needs_at_least_high: 0.8 })),
      signals: QUIET,
      state: () => 'state',
      onTrace: () => undefined,
    });
    expect(decision).toMatchObject({ wire: 'high', applied: true });
  });

  it('holds the last answer when System 1 goes quiet, but the floor still wins', async () => {
    const router = createEffortRouter();
    const answers: Array<Record<string, number> | null> = [
      { needs_at_least_medium: 0.05, needs_at_least_high: 0.01 },
      { needs_at_least_medium: 0.05, needs_at_least_high: 0.01 },
      null,
      null,
      null,
    ];
    const port = fakePort('enforce', async () => answers.shift() ?? null);
    const policy = buildEffortPolicy(LEVELS, 'auto', true);
    const decide = (signals: EffortSignals) =>
      router.decide({ policy, system1: port, signals, state: () => 'state', onTrace: () => undefined });

    expect((await decide({ ...QUIET, iteration: 4 })).wire).toBe('medium'); // lower_pending
    expect((await decide({ ...QUIET, iteration: 5 })).wire).toBe('low'); // lower
    // Next ask is due (cadence), but the budget is spent: keep System 1's
    // last rung, not the baseline.
    expect(await decide({ ...QUIET, iteration: 8 })).toMatchObject({
      wire: 'low',
      applied: true,
      trace: expect.objectContaining({ reason: 'held', chosen: 'low' }),
    });
    // A write raises the floor to the baseline for this iteration only…
    expect((await decide({ ...QUIET, iteration: 9, wrote: true })).wire).toBe('medium');
    // …then the held rung comes back.
    expect((await decide({ ...QUIET, iteration: 10 })).wire).toBe('low');
    expect(answers).toEqual([]);
  });

  it('holds the baseline while no evidence arrives, without asking System 1 more often (F-4)', async () => {
    const router = createEffortRouter();
    const easy = { needs_at_least_medium: 0.05, needs_at_least_high: 0.01 };
    let asks = 0;
    const port = fakePort('enforce', async () => {
      asks += 1;
      return easy;
    });
    const policy = buildEffortPolicy(LEVELS, 'auto', true);
    const decide = (signals: EffortSignals) =>
      router.decide({ policy, system1: port, signals, state: () => 'state', onTrace: () => undefined });

    await decide({ ...QUIET, iteration: 4, idleSteps: 0 }); // lower_pending
    expect((await decide({ ...QUIET, iteration: 5, idleSteps: 1 })).wire).toBe('low'); // evidence flowing: lower
    // Three steps without evidence: back to the baseline, held without an ask.
    expect(await decide({ ...QUIET, iteration: 6, idleSteps: 3 })).toMatchObject({
      wire: 'medium',
      trace: expect.objectContaining({ reason: 'cadence_hold', floor: 'medium' }),
    });
    expect(asks).toBe(2);
    // Evidence again: System 1's lower rung comes back.
    expect((await decide({ ...QUIET, iteration: 7, idleSteps: 0 })).wire).toBe('low');
  });

  it('asks at events and every few quiet iterations, holding in between', async () => {
    const router = createEffortRouter();
    const easy = { needs_at_least_medium: 0.05, needs_at_least_high: 0.01 };
    const hard = { needs_at_least_medium: 0.95, needs_at_least_high: 0.8 };
    const answers = [easy, easy, hard, hard];
    let asks = 0;
    const port = fakePort('enforce', async () => {
      asks += 1;
      return answers.shift() ?? null;
    });
    const policy = buildEffortPolicy(LEVELS, 'auto', true);
    const decide = (signals: EffortSignals) =>
      router.decide({ policy, system1: port, signals, state: () => 'state', onTrace: () => undefined });

    await decide({ ...QUIET, iteration: 4 }); // lower_pending
    expect((await decide({ ...QUIET, iteration: 5 })).wire).toBe('low'); // confirming ask is never skipped
    expect(await decide({ ...QUIET, iteration: 6 })).toMatchObject({
      wire: 'low',
      trace: expect.objectContaining({ reason: 'cadence_hold' }),
    });
    await decide({ ...QUIET, iteration: 7 });
    expect(asks).toBe(2);
    // Three quiet iterations after the last ask: ask again (and raise).
    expect((await decide({ ...QUIET, iteration: 8 })).wire).toBe('high');
    // An event (tool error) always asks, even right after an ask.
    await decide({ ...QUIET, iteration: 9, toolError: true });
    expect(asks).toBe(4);
  });

  it('falls back to the baseline when System 1 has never answered', async () => {
    const router = createEffortRouter();
    const decision = await router.decide({
      policy: buildEffortPolicy(LEVELS, 'auto', true),
      system1: fakePort('enforce', async () => null),
      signals: QUIET,
      state: () => 'state',
      onTrace: () => undefined,
    });
    expect(decision).toMatchObject({ wire: 'medium', applied: false });
  });

  it('falls back to the baseline when the port throws', async () => {
    const router = createEffortRouter();
    const port = fakePort('enforce', async () => {
      throw new Error('bug');
    });
    const decision = await router.decide({
      policy: buildEffortPolicy(LEVELS, 'auto', true),
      system1: port,
      signals: QUIET,
      state: () => 'state',
      onTrace: () => undefined,
    });
    expect(decision).toMatchObject({ wire: 'medium', applied: false });
    expect(port.notes).toEqual(['internal']);
  });

  it('never blocks or applies in shadow mode, and traces when the answer lands', async () => {
    const router = createEffortRouter();
    const traces: System1EffortTrace[] = [];
    let release!: (scores: Record<string, number>) => void;
    const port = fakePort('shadow', () => new Promise((resolve) => (release = resolve)));
    const decision = await router.decide({
      policy: buildEffortPolicy(LEVELS, 'medium', false),
      system1: port,
      signals: QUIET,
      state: () => 'state',
      onTrace: (trace) => traces.push(trace),
    });
    expect(decision).toEqual({ wire: 'medium', applied: false });
    expect(traces).toEqual([]);
    release({ needs_at_least_medium: 0.95, needs_at_least_high: 0.8 });
    await port.settle();
    expect(traces).toEqual([expect.objectContaining({ mode: 'shadow', chosen: 'high', applied: false })]);
  });

  it('skips the call when nothing can change', async () => {
    const router = createEffortRouter();
    let asked = false;
    const decision = await router.decide({
      policy: buildEffortPolicy(LEVELS, 'high', false),
      system1: fakePort('shadow', async () => {
        asked = true;
        return null;
      }),
      signals: { ...QUIET, toolError: true },
      state: () => 'state',
      onTrace: () => undefined,
    });
    expect(decision.wire).toBe('high');
    expect(asked).toBe(false);
  });
});

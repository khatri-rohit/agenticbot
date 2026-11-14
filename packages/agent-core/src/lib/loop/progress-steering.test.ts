/**
 * Stall advice needs both: real idle spend and several steps without
 * evidence. Spend alone is not a stall: with a large prompt two calls pass
 * the token mark while the run is still reading what it needs (live run
 * e3036b78: 160k per call, the 180k mark tripped on the second call).
 */
import { describe, expect, it } from 'vitest';

import { emptyRunUsage, PROGRESS_MARKS, type TaskClass } from '@agent/agent-models';

import { resolveLimits } from './limits';
import { ProgressSteering } from './progress-steering';
import { RunBudget } from './run-budget';

function steering(spent: number, idleSteps: number, taskClass: TaskClass = 'small'): ProgressSteering {
  const usage = emptyRunUsage();
  usage.own.promptTokens = spent;
  const budget = new RunBudget(usage, resolveLimits({ maxPromptTokens: 10_000_000 }), Date.now());
  return new ProgressSteering(
    budget,
    { stall: true, gate: false },
    () => false,
    () => 0,
    () => taskClass,
    () => idleSteps,
  );
}

describe('stall advice', () => {
  it('does not fire after two expensive calls', () => {
    // 320k idle tokens is past the small-task mark (180k), but only two steps passed.
    expect(steering(320_000, 2).stalled()).toBeUndefined();
    expect(steering(320_000, PROGRESS_MARKS.stallMinIdleSteps - 1).takeStallNudge()).toBeUndefined();
  });

  it('fires once the idle spend and the idle steps are both past their marks', () => {
    const stall = steering(320_000, PROGRESS_MARKS.stallMinIdleSteps).stalled();
    expect(stall).toMatchObject({ idle: 320_000, taskClass: 'small' });
  });

  it('does not fire on many cheap idle steps under the token mark', () => {
    expect(steering(100_000, 12).stalled()).toBeUndefined();
  });

  it('is said once per idle stretch', () => {
    const s = steering(320_000, PROGRESS_MARKS.stallMinIdleSteps);
    expect(s.takeStallNudge()).toBeDefined();
    expect(s.takeStallNudge()).toBeUndefined();
  });
});

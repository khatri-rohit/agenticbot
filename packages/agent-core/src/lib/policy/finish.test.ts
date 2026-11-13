import { describe, expect, it } from 'vitest';

import { changeGate, planGate } from './finish';

describe('changeGate', () => {
  const base = {
    enabled: true,
    alreadySent: false,
    posture: 'agent',
    unchecked: true,
    canRunChecks: true,
    answer: 'Fixed: the button works now.',
  };
  it('sends an unchecked success claim back once', () => {
    expect(changeGate(base)).toBe(true);
    expect(changeGate({ ...base, alreadySent: true })).toBe(false);
  });
  it('lets the answer stand when it admits it is unverified, or nothing is unchecked', () => {
    expect(changeGate({ ...base, answer: 'Fixed, but not tested.' })).toBe(false);
    expect(changeGate({ ...base, unchecked: false })).toBe(false);
    expect(changeGate({ ...base, answer: 'Here is what I changed.' })).toBe(false);
  });
  it('applies only to Agent runs that can run a check', () => {
    expect(changeGate({ ...base, posture: 'ask' })).toBe(false);
    expect(changeGate({ ...base, canRunChecks: false })).toBe(false);
  });
});

describe('planGate', () => {
  it('nudges once for open plan work, then stops', () => {
    expect(planGate({ openPlanWork: false, nudges: 0 })).toBe('pass');
    expect(planGate({ openPlanWork: true, nudges: 0 })).toBe('nudge');
    expect(planGate({ openPlanWork: true, nudges: 1 })).toBe('stop');
  });
});

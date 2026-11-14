import { describe, expect, it } from 'vitest';

import { EFFORT_IDLE_FLOOR_STEPS } from '@agent/agent-models';

import { effortFloor, escalationStep, isSteadyFloor, type EffortSignals } from './effort';

const QUIET: EffortSignals = { iteration: 4, steering: false, toolError: false, wrote: false, idleSteps: 0 };

describe('effortFloor', () => {
  it('forbids lowering on the first turn, after errors, writes and new instructions', () => {
    expect(effortFloor({ ...QUIET, iteration: 1 }, 2).reason).toBe('first_turn');
    expect(effortFloor({ ...QUIET, toolError: true }, 2).index).toBe(2);
    expect(effortFloor({ ...QUIET, wrote: true }, 2).index).toBe(2);
    expect(effortFloor({ ...QUIET, steering: true }, 2).index).toBe(2);
    expect(effortFloor(QUIET, 2)).toEqual({ index: 0, reason: 'none' });
  });

  it('holds the baseline once steps pass without evidence, and lets go when evidence arrives', () => {
    expect(effortFloor({ ...QUIET, idleSteps: EFFORT_IDLE_FLOOR_STEPS - 1 }, 2)).toEqual({ index: 0, reason: 'none' });
    expect(effortFloor({ ...QUIET, idleSteps: EFFORT_IDLE_FLOOR_STEPS }, 2)).toEqual({ index: 2, reason: 'no_progress' });
    expect(effortFloor({ ...QUIET, idleSteps: 0 }, 2).reason).toBe('none');
  });

  it('treats only the holding floors as steady (no extra System 1 asks)', () => {
    expect(isSteadyFloor('none')).toBe(true);
    expect(isSteadyFloor('no_progress')).toBe(true);
    expect(isSteadyFloor('tool_error')).toBe(false);
  });
});

describe('escalationStep', () => {
  it('raises on trouble and holds it until the next evidence', () => {
    expect(escalationStep({ escalatedAt: null, evidenceCount: 2, trouble: false })).toEqual({ escalatedAt: null, change: null });
    expect(escalationStep({ escalatedAt: null, evidenceCount: 2, trouble: true })).toEqual({ escalatedAt: 2, change: 'escalate' });
    expect(escalationStep({ escalatedAt: 2, evidenceCount: 2, trouble: true })).toEqual({ escalatedAt: 2, change: null });
    expect(escalationStep({ escalatedAt: 2, evidenceCount: 3, trouble: false })).toEqual({ escalatedAt: null, change: 'release' });
  });

  it('stays raised when new trouble comes with the evidence', () => {
    expect(escalationStep({ escalatedAt: 2, evidenceCount: 3, trouble: true })).toEqual({ escalatedAt: 3, change: null });
  });
});

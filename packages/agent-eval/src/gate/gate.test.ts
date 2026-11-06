import { describe, expect, it } from 'vitest';

import { compareToBaseline, type Baseline } from './gate.js';
import type { SuiteStats, TaskStats } from './summary.js';

const task = (passes: number, medianPromptTokens: number): TaskStats => ({
  taskId: 'readme-glossary',
  taskHash: 'h',
  trials: 3,
  passes,
  errors: 0,
  passRate: passes / 3,
  medianPromptTokens,
  medianMinutes: 2,
  spread: 1.2,
  stable: true,
  scopeViolations: 0,
});

const stats = (system1Setup: string, passes: number, tokens: number): SuiteStats => ({
  model: 'm',
  seedHash: 's',
  harnessSha: 'abc',
  harnessDirty: null,
  system1Setup,
  tasks: { 'readme-glossary': task(passes, tokens) },
  passRate: passes / 3,
});

const baseline: Baseline = { suite: 'regression', recordedAt: '2026-11-04T00:00:00.000Z', ...stats('enforce/thinking=default', 3, 100_000) };

describe('compareToBaseline and System 1 setups', () => {
  it('refuses a different setup unless asked to compare setups', () => {
    const result = compareToBaseline(baseline, stats('enforce/thinking=auto', 3, 80_000));
    expect(result.kind).toBe('refuse');
    expect(result.kind === 'refuse' && result.reasons[0]).toMatch(/System 1 setup differs/);
  });

  it('passes a setup comparison with the same pass rate and fewer tokens', () => {
    const result = compareToBaseline(baseline, stats('enforce/thinking=auto', 3, 80_000), 'system1');
    expect(result).toMatchObject({ kind: 'verdict', passed: true });
  });

  it('fails a setup comparison that does not lower tokens', () => {
    const result = compareToBaseline(baseline, stats('enforce/thinking=auto', 3, 105_000), 'system1');
    expect(result).toMatchObject({ kind: 'verdict', passed: false });
    expect(result.kind === 'verdict' && result.suiteFailures[0]).toMatch(/did not lower/);
  });

  it('fails a setup comparison that loses passing trials', () => {
    const result = compareToBaseline(baseline, stats('enforce/thinking=auto', 1, 60_000), 'system1');
    expect(result).toMatchObject({ kind: 'verdict', passed: false });
  });

  it('refuses --compare system1 when the setups are the same', () => {
    expect(compareToBaseline(baseline, stats('enforce/thinking=default', 3, 80_000), 'system1').kind).toBe('refuse');
  });

  it('treats a baseline recorded before setups existed as unrecorded', () => {
    const { system1Setup: _dropped, ...old } = baseline;
    expect(compareToBaseline(old as Baseline, stats('off/thinking=default', 3, 100_000)).kind).toBe('refuse');
  });
});

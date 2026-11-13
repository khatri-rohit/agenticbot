import { describe, expect, it } from 'vitest';

import { PROGRESS_MARKS } from '@agent/agent-models';

import { progressMarks, progressScope } from './progress';
import { taskClassFor } from './task-class';

describe('progressScope', () => {
  it('gives stall advice to every capped top-level run, the gate only to one that can edit', () => {
    expect(progressScope({ capped: true, depth: 0, posture: 'agent', canEdit: true })).toEqual({ stall: true, gate: true });
    expect(progressScope({ capped: true, depth: 0, posture: 'ask', canEdit: false })).toEqual({ stall: true, gate: false });
    expect(progressScope({ capped: true, depth: 1, posture: 'agent', canEdit: false })).toEqual({ stall: false, gate: false });
    expect(progressScope({ capped: false, depth: 0, posture: 'agent', canEdit: true })).toEqual({ stall: false, gate: false });
  });
});

describe('progressMarks', () => {
  it('scales with the budget and stops at the absolute caps', () => {
    expect(progressMarks(1_000_000, false)).toEqual({ stall: 300_000, gate: 500_000 });
    expect(progressMarks(10_000_000, false)).toEqual({
      stall: PROGRESS_MARKS.stallMaxTokens,
      gate: PROGRESS_MARKS.gateMaxTokens,
    });
    expect(progressMarks(1_000_000, true)).toEqual({ stall: 200_000, gate: 350_000 });
  });
});

describe('taskClassFor', () => {
  const none = { steps: 0, editedFiles: 0, edits: 0, findings: 0 };
  it('promotes on steps for every shape', () => {
    expect(taskClassFor({ ...none, steps: 11 })).toBe('small');
    expect(taskClassFor({ ...none, steps: 12 })).toBe('medium');
    expect(taskClassFor({ ...none, steps: 40 })).toBe('long');
  });
  it('promotes a change on edits and a research task on findings', () => {
    expect(taskClassFor({ ...none, editedFiles: 3 })).toBe('medium');
    expect(taskClassFor({ ...none, edits: 4 })).toBe('medium');
    expect(taskClassFor({ ...none, editedFiles: 8 })).toBe('long');
    expect(taskClassFor({ ...none, findings: 20 })).toBe('medium');
    expect(taskClassFor({ ...none, findings: 80 })).toBe('long');
  });
});

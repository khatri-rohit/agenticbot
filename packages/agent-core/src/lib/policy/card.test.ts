import { describe, expect, it } from 'vitest';

import { CARD_MARKS } from '@agent/agent-models';

import { cardDue, cardItems, type CardFacts } from './card';

const BASE: CardFacts = {
  shape: 'unknown',
  posture: 'agent',
  taskClass: 'small',
  canDelegate: true,
  canRecord: true,
  edits: 0,
  unverifiedSince: null,
  lastCheck: null,
  reviewed: false,
  rereadPaths: [],
  childGaps: [],
  serialReadTurns: 0,
  nearBudget: false,
};

const ids = (facts: Partial<CardFacts>) => cardItems({ ...BASE, ...facts }).map((item) => item.id);
const passed = { command: 'npm test', exitCode: 0, iteration: 3, afterEdit: true, check: true };
const failed = { ...passed, exitCode: 1 };

describe('cardItems', () => {
  it('shows nothing when nothing is open', () => {
    expect(ids({})).toEqual([]);
  });

  it('asks for a check after edits, and names a failed one', () => {
    expect(ids({ edits: 1, unverifiedSince: 2 })).toEqual(['open:unchecked']);
    expect(ids({ edits: 1, lastCheck: failed })).toEqual(['open:check_failed']);
  });

  it('asks for review once, only for a larger change that passes its check, in Agent with delegate', () => {
    const passing = { edits: 3, lastCheck: passed, taskClass: 'medium' as const };
    expect(ids(passing)).toEqual(['open:review']);
    expect(ids({ ...passing, taskClass: 'small' })).toEqual([]);
    expect(ids({ ...passing, reviewed: true })).toEqual([]);
    expect(ids({ ...passing, canDelegate: false })).toEqual([]);
    expect(ids({ ...passing, posture: 'ask' })).toEqual([]);
  });

  it('names re-reads only when findings can be recorded and the task is not a change', () => {
    expect(ids({ rereadPaths: ['a.ts'] })).toEqual(['open:reread']);
    expect(ids({ rereadPaths: ['a.ts'], shape: 'change' })).toEqual([]);
    expect(ids({ rereadPaths: ['a.ts'], canRecord: false })).toEqual([]);
  });

  it('lists sub-agent gaps, serial reads, stall and budget while they hold', () => {
    expect(
      ids({
        childGaps: ['where is X set?'],
        serialReadTurns: CARD_MARKS.serialReadAdviceAfter,
        stall: { idle: 300_000, max: 1_000_000, pace: 600_000, taskClass: 'small' },
        nearBudget: true,
      }),
    ).toEqual(['open:child_gaps', 'advice:serial_reads', 'advice:stall', 'advice:budget']);
    expect(ids({ serialReadTurns: CARD_MARKS.serialReadAdviceAfter - 1 })).toEqual([]);
  });
});

describe('cardDue', () => {
  it('sends news at once, and otherwise waits for the quiet steps and a working set', () => {
    expect(cardDue({ hasNews: true, step: 1, workingSetSize: 0 })).toBe(true);
    expect(cardDue({ hasNews: false, step: CARD_MARKS.quietSteps, workingSetSize: 3 })).toBe(false);
    expect(cardDue({ hasNews: false, step: CARD_MARKS.quietSteps + 1, workingSetSize: 0 })).toBe(false);
    expect(cardDue({ hasNews: false, step: CARD_MARKS.quietSteps + 1, workingSetSize: 3 })).toBe(true);
  });
});

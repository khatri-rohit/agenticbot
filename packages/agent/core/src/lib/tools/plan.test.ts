import { describe, expect, it } from 'vitest';
import {
  emptyThreadPlan,
  formatThreadPlanForPrompt,
  planHasOpenWork,
  selectPlanForRewind,
} from '@org/agent-models';

import {
  applyPlanAction,
  applyTodoUpdate,
  createInMemoryPlanStore,
  createPlanTools,
} from './plan';
import { createToolRegistry } from './registry';

describe('thread plan mutations', () => {
  it('journals goal, notes, decisions, then locks a final plan', () => {
    let plan = emptyThreadPlan('t1');
    const goal = applyPlanAction(plan, {
      action: 'set_goal',
      text: 'Add thread plan artifacts',
    });
    expect(goal.ok).toBe(true);
    if (!goal.ok) return;
    plan = goal.plan;

    const note = applyPlanAction(plan, {
      action: 'note',
      kind: 'approach',
      text: 'Journal in Agent, not Ask-only',
    });
    expect(note.ok).toBe(true);
    if (!note.ok) return;
    plan = note.plan;

    const decide = applyPlanAction(plan, {
      action: 'decide',
      text: 'One plan.json per thread',
    });
    expect(decide.ok).toBe(true);
    if (!decide.ok) return;
    plan = decide.plan;

    const locked = applyPlanAction(plan, {
      action: 'finalize',
      text: 'Persist plan.json. Inject into assembleContext. Todos track work.',
    });
    expect(locked.ok).toBe(true);
    if (!locked.ok) return;
    expect(locked.plan.final).toMatch(/plan\.json/);
    expect(locked.plan.decisions[0]?.text).toMatch(/One plan.json/);
  });

  it('rejects finalize without text', () => {
    const result = applyPlanAction(emptyThreadPlan('t1'), {
      action: 'finalize',
    });
    expect(result.ok).toBe(false);
  });

  it('keeps a single in_progress todo and merges by id', () => {
    const seed = emptyThreadPlan('t1');
    const created = applyTodoUpdate(seed, {
      merge: false,
      todos: [
        { id: 'a', content: 'Types', status: 'completed' },
        { id: 'b', content: 'Tools', status: 'in_progress' },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const merged = applyTodoUpdate(created.plan, {
      merge: true,
      todos: [
        { id: 'b', content: 'Tools', status: 'completed' },
        { id: 'c', content: 'UI', status: 'in_progress' },
        { id: 'd', content: 'Checks', status: 'in_progress' },
      ],
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const inProgress = merged.plan.todos.filter(
      (todo) => todo.status === 'in_progress',
    );
    expect(inProgress).toHaveLength(1);
    expect(inProgress[0]?.id).toBe('d');
    expect(merged.plan.todos.map((todo) => todo.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
  });

  it('plan and todo stay available in Ask posture', async () => {
    const store = createInMemoryPlanStore('t1');
    const tools = createToolRegistry(
      createPlanTools(store),
      ['plan', 'todo'],
      'ask',
    );
    expect(tools.byName.has('plan')).toBe(true);
    expect(tools.byName.has('todo')).toBe(true);
    const planTool = tools.byName.get('plan');
    const result = await planTool?.execute(
      { action: 'set_goal', text: 'Ship the journal' },
      {
        runId: 'r1',
        threadId: 't1',
        origin: 'eval',
        signal: new AbortController().signal,
      },
    );
    expect(result).toMatch(/Ship the journal/);
    const saved = await store.read();
    expect(saved.goal).toBe('Ship the journal');
  });

  it('omits the journal from the prompt once a final plan exists', () => {
    const plan = emptyThreadPlan('t1');
    plan.goal = 'Add plan journal';
    plan.notes = [
      {
        id: 'n1',
        at: '2026-01-01T00:00:00.000Z',
        kind: 'approach',
        text: 'Do not dump forty notes',
      },
    ];
    plan.decisions = [
      {
        id: 'd1',
        at: '2026-01-01T00:00:00.000Z',
        text: 'Thread-scoped artifact',
      },
    ];
    plan.final = 'Write plan.json and inject a slim brief.';
    plan.todos = [
      { id: 'a', content: 'Types', status: 'completed' },
      { id: 'b', content: 'UI card', status: 'in_progress' },
    ];
    const text = formatThreadPlanForPrompt(plan);
    expect(text).toContain('Write plan.json');
    expect(text).toContain('UI card');
    expect(text).not.toContain('Do not dump forty notes');
    expect(text).not.toContain('Thread-scoped artifact');
  });

  it('treats a locked plan with open todos as unfinished work', () => {
    const plan = emptyThreadPlan('t1');
    expect(planHasOpenWork(plan)).toBe(false);
    plan.final = 'Ship it';
    plan.todos = [{ id: 'a', content: 'Types', status: 'pending' }];
    expect(planHasOpenWork(plan)).toBe(true);
    plan.todos = [{ id: 'a', content: 'Types', status: 'completed' }];
    expect(planHasOpenWork(plan)).toBe(false);
  });

  it('finalize clears open todos so a locked plan stops nudging', () => {
    let plan = emptyThreadPlan('t1');
    plan.todos = [
      { id: 'a', content: 'Types', status: 'in_progress' },
      { id: 'b', content: 'Tests', status: 'pending' },
    ];
    expect(planHasOpenWork(plan)).toBe(false); // no final yet

    const result = applyPlanAction(plan, { action: 'finalize', text: 'Ship it' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    plan = result.plan;

    expect(plan.final).toBe('Ship it');
    expect(plan.todos).toEqual([]);
    expect(planHasOpenWork(plan)).toBe(false);
  });

  it('restores the last plan written at or before the rewind seq', () => {
    const first = emptyThreadPlan('t1');
    first.goal = 'v1';
    first.ledgerSeq = 4;
    const second = emptyThreadPlan('t1');
    second.goal = 'v2';
    second.ledgerSeq = 12;
    expect(selectPlanForRewind([first, second], 10, 't1').goal).toBe('v1');
    expect(selectPlanForRewind([first, second], 12, 't1').goal).toBe('v2');
    expect(selectPlanForRewind([first, second], 2, 't1').goal).toBe('');
  });
});

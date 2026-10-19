import { describe, expect, it } from 'vitest';
import { emptyThreadPlan } from '@org/agent-models';

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
});

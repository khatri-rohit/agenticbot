import { randomUUID } from 'node:crypto';
import type {
  PlanAction,
  PlanNoteKind,
  PlanTodo,
  PlanTodoStatus,
  ThreadPlan,
  ToolContext,
} from '@desk/agent-models';
import {
  MAX_PLAN_DECISIONS,
  MAX_PLAN_FINAL_CHARS,
  MAX_PLAN_GOAL_CHARS,
  MAX_PLAN_NOTE_CHARS,
  MAX_PLAN_NOTES,
  MAX_PLAN_TODO_CHARS,
  MAX_PLAN_TODOS,
  emptyThreadPlan,
  formatThreadPlanForPrompt,
} from '@desk/agent-models';

import type { Tool } from './type';

export type PlanStore = {
  read: () => Promise<ThreadPlan>;
  write: (plan: ThreadPlan) => Promise<ThreadPlan>;
};

export type PlanActionInput = {
  action: PlanAction;
  text?: string;
  kind?: PlanNoteKind;
};

export type TodoUpdateInput = {
  merge: boolean;
  todos: Array<{ id?: string; content: string; status?: PlanTodoStatus }>;
};

export type PlanMutation =
  | { ok: true; plan: ThreadPlan }
  | { ok: false; error: string };

function nowIso(): string {
  return new Date().toISOString();
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().slice(0, 8)}`;
}

function parseAction(value: unknown): PlanAction | null {
  if (
    value === 'set_goal' ||
    value === 'note' ||
    value === 'decide' ||
    value === 'finalize' ||
    value === 'revise' ||
    value === 'clear'
  ) {
    return value;
  }
  return null;
}

function parseNoteKind(value: unknown): PlanNoteKind {
  if (value === 'approach' || value === 'constraint' || value === 'note') {
    return value;
  }
  return 'note';
}

function parseTodoStatus(value: unknown): PlanTodoStatus {
  if (value === 'in_progress' || value === 'completed' || value === 'pending') {
    return value;
  }
  return 'pending';
}

function coerceOneInProgress(todos: PlanTodo[]): PlanTodo[] {
  let seen = false;
  const next: PlanTodo[] = [];
  for (let i = todos.length - 1; i >= 0; i--) {
    const todo = todos[i];
    if (todo.status !== 'in_progress') {
      next.push(todo);
      continue;
    }
    if (seen) {
      next.push({ ...todo, status: 'pending' });
      continue;
    }
    seen = true;
    next.push(todo);
  }
  next.reverse();
  return next;
}

/** Deterministic journal mutation. Host persists the returned plan. */
export function applyPlanAction(
  plan: ThreadPlan,
  input: PlanActionInput,
): PlanMutation {
  const at = nowIso();
  if (input.action === 'clear') {
    return { ok: true, plan: emptyThreadPlan(plan.threadId) };
  }

  if (input.action === 'set_goal') {
    const goal = clip(input.text ?? '', MAX_PLAN_GOAL_CHARS);
    if (!goal) return { ok: false, error: 'set_goal needs text.' };
    return {
      ok: true,
      plan: { ...plan, goal, updatedAt: at },
    };
  }

  if (input.action === 'note') {
    const text = clip(input.text ?? '', MAX_PLAN_NOTE_CHARS);
    if (!text) return { ok: false, error: 'note needs text.' };
    const notes = [
      ...plan.notes,
      {
        id: newId('n'),
        at,
        kind: input.kind ?? 'note',
        text,
      },
    ].slice(-MAX_PLAN_NOTES);
    return { ok: true, plan: { ...plan, notes, updatedAt: at } };
  }

  if (input.action === 'decide') {
    const text = clip(input.text ?? '', MAX_PLAN_NOTE_CHARS);
    if (!text) return { ok: false, error: 'decide needs text.' };
    const decisions = [
      ...plan.decisions,
      { id: newId('d'), at, text },
    ].slice(-MAX_PLAN_DECISIONS);
    return { ok: true, plan: { ...plan, decisions, updatedAt: at } };
  }

  if (input.action === 'finalize') {
    const text = clip(input.text ?? '', MAX_PLAN_FINAL_CHARS);
    if (!text) {
      return {
        ok: false,
        error:
          'finalize needs the complete plan text (goal, locked decisions, files, steps).',
      };
    }
    // finalize locks the plan; todos are execution scratch. Clearing them
    // prevents planHasOpenWork from nudging forever on a locked plan.
    return {
      ok: true,
      plan: { ...plan, final: text, todos: [], updatedAt: at },
    };
  }

  const text = clip(input.text ?? '', MAX_PLAN_FINAL_CHARS);
  if (!text) return { ok: false, error: 'revise needs the updated final plan.' };
  if (!plan.final) {
    return {
      ok: false,
      error: 'No final plan yet. Use finalize first, or set_goal / decide.',
    };
  }
  return { ok: true, plan: { ...plan, final: text, updatedAt: at } };
}

/** Replace or merge todos. At most one item stays in_progress. */
export function applyTodoUpdate(
  plan: ThreadPlan,
  input: TodoUpdateInput,
): PlanMutation {
  if (input.todos.length === 0 && !input.merge) {
    return {
      ok: true,
      plan: { ...plan, todos: [], updatedAt: nowIso() },
    };
  }
  if (input.todos.length === 0) {
    return { ok: false, error: 'todo merge needs at least one item.' };
  }
  if (input.todos.length > MAX_PLAN_TODOS) {
    return {
      ok: false,
      error: `At most ${MAX_PLAN_TODOS} todos.`,
    };
  }

  const incoming: PlanTodo[] = [];
  for (const item of input.todos) {
    const content = clip(item.content, MAX_PLAN_TODO_CHARS);
    if (!content) continue;
    incoming.push({
      id: item.id?.trim() || newId('t'),
      content,
      status: item.status ?? 'pending',
    });
  }
  if (incoming.length === 0) {
    return { ok: false, error: 'Each todo needs content.' };
  }

  let todos: PlanTodo[];
  if (!input.merge) {
    todos = incoming;
  } else {
    const byId = new Map(plan.todos.map((todo) => [todo.id, todo]));
    const order = plan.todos.map((todo) => todo.id);
    for (const item of incoming) {
      if (!byId.has(item.id)) order.push(item.id);
      byId.set(item.id, item);
    }
    todos = order
      .map((id) => byId.get(id))
      .filter((todo): todo is PlanTodo => todo !== undefined);
  }

  todos = coerceOneInProgress(todos).slice(0, MAX_PLAN_TODOS);
  return {
    ok: true,
    plan: { ...plan, todos, updatedAt: nowIso() },
  };
}

function summarizePlan(plan: ThreadPlan): string {
  return formatThreadPlanForPrompt(plan);
}

export function createInMemoryPlanStore(threadId: string): PlanStore {
  let plan = emptyThreadPlan(threadId);
  return {
    read: async () => plan,
    write: async (next) => {
      plan = next;
      return plan;
    },
  };
}

export function createPlanTools(store: PlanStore): Tool[] {
  const planTool: Tool = {
    definition: {
      type: 'function',
      function: {
        name: 'plan',
        description:
          'Update this thread\'s plan journal. Works in Ask and Agent. set_goal / note / decide while discussing. finalize with the complete plan when the user says implement, go, or lock it. revise if they change a locked plan. clear only to start over.',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: [
                'set_goal',
                'note',
                'approach',
                'constraint',
                'decide',
                'finalize',
                'revise',
                'clear',
              ],
              description:
                'set_goal, note (optional kind), decide, finalize, revise, or clear. approach/constraint are note kinds accepted as action for convenience.',
            },
            kind: {
              type: 'string',
              enum: ['note', 'approach', 'constraint'],
              description: 'For action=note. Defaults to note.',
            },
            text: {
              type: 'string',
              description:
                'Goal, journal line, locked decision, or the full final plan.',
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
      },
    },
    guidance: {
      whenToUse: [
        'Non-trivial work: set the goal, journal approaches, lock decisions, then finalize before (or as) you implement.',
        'The user says implement, go, do it, or finalize — write the complete plan, then use todo.',
        'A decision or constraint must survive the next turns so you do not wander.',
      ],
      whenNotToUse: [
        'One-shot trivia, a single obvious edit, or a question you can answer without a plan.',
        'USER.md / MEMORY.md facts — that is memory.',
        'Repeating the same note already in the journal.',
      ],
      usage: [
        'Ask and Agent both use this tool. Do not wait for Ask mode to journal.',
        'finalize text must be the full plan (goal, decisions, files, steps), not "ok".',
        'After finalize, call todo with the work items, then execute against those todos.',
      ],
    },
    risk: 'write',
    execute: async (args) => {
      const rawAction = args.action;
      let action = parseAction(rawAction);
      let kind = parseNoteKind(args.kind);
      if (
        rawAction === 'approach' ||
        rawAction === 'constraint' ||
        rawAction === 'note'
      ) {
        action = 'note';
        kind = parseNoteKind(rawAction);
      }
      if (!action) return 'Unknown plan action.';
      const current = await store.read();
      const result = applyPlanAction(current, {
        action,
        text: typeof args.text === 'string' ? args.text : undefined,
        kind,
      });
      if (!result.ok) return `Rejected: ${result.error}`;
      const saved = await store.write(result.plan);
      return summarizePlan(saved);
    },
  };

  const todoTool: Tool = {
    definition: {
      type: 'function',
      function: {
        name: 'todo',
        description:
          'Set or update this thread\'s implementation checklist. Use after a plan exists (or with finalize). merge=true upserts by id; merge=false replaces the list. One item in_progress at a time. Mark completed as you finish.',
        parameters: {
          type: 'object',
          properties: {
            merge: {
              type: 'boolean',
              description:
                'true = upsert listed items. false = replace the whole list.',
            },
            todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'Stable id. Omit to create.',
                  },
                  content: { type: 'string' },
                  status: {
                    type: 'string',
                    enum: ['pending', 'in_progress', 'completed'],
                  },
                },
                required: ['content'],
                additionalProperties: false,
              },
            },
          },
          required: ['merge', 'todos'],
          additionalProperties: false,
        },
      },
    },
    guidance: {
      whenToUse: [
        'You have a final plan (or are about to implement) and need a visible work list.',
        'You finished or started a step — update that item\'s status.',
      ],
      whenNotToUse: [
        'No implementation work yet — journal with plan first.',
        'A single trivial edit that does not need a checklist.',
      ],
      usage: [
        'Create the list from the final plan, then keep it current while you edit and verify.',
        'Exactly one in_progress item. Do not finish the run with open todos unless you are stuck.',
      ],
    },
    risk: 'write',
    execute: async (args, _ctx: ToolContext) => {
      const merge = args.merge !== false;
      const rawTodos = Array.isArray(args.todos) ? args.todos : [];
      const todos: TodoUpdateInput['todos'] = [];
      for (const item of rawTodos) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const rec = item as Record<string, unknown>;
        if (typeof rec.content !== 'string') continue;
        todos.push({
          id: typeof rec.id === 'string' ? rec.id : undefined,
          content: rec.content,
          status: parseTodoStatus(rec.status),
        });
      }
      const current = await store.read();
      const result = applyTodoUpdate(current, { merge, todos });
      if (!result.ok) return `Rejected: ${result.error}`;
      const saved = await store.write(result.plan);
      return summarizePlan(saved);
    },
  };

  return [planTool, todoTool];
}

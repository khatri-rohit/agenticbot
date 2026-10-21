/**
 * Thread-scoped plan journal + implementation todos.
 * Not Ask-only and not a Cursor Plan Mode clone: one artifact the model
 * updates while discussing, then sticks to while building.
 * Ledger remains the movie; this file is the stick-to-it brief.
 */

export const MAX_PLAN_NOTES = 40;
export const MAX_PLAN_DECISIONS = 20;
export const MAX_PLAN_TODOS = 24;
export const MAX_PLAN_GOAL_CHARS = 400;
export const MAX_PLAN_NOTE_CHARS = 800;
export const MAX_PLAN_FINAL_CHARS = 8_000;
export const MAX_PLAN_TODO_CHARS = 240;
/** Journal lines kept in the prompt while still planning. Locked plans omit the journal. */
export const MAX_PLAN_PROMPT_NOTES = 8;

export type PlanNoteKind = 'note' | 'approach' | 'constraint';
export type PlanTodoStatus = 'pending' | 'in_progress' | 'completed';
export type PlanAction =
  | 'set_goal'
  | 'note'
  | 'decide'
  | 'finalize'
  | 'revise'
  | 'clear';

export type PlanNote = {
  id: string;
  at: string;
  kind: PlanNoteKind;
  text: string;
};

export type PlanDecision = {
  id: string;
  at: string;
  text: string;
};

export type PlanTodo = {
  id: string;
  content: string;
  status: PlanTodoStatus;
};

export type ThreadPlan = {
  threadId: string;
  goal: string;
  notes: PlanNote[];
  decisions: PlanDecision[];
  /** Locked implementation plan. Null while still journaling. */
  final: string | null;
  todos: PlanTodo[];
  updatedAt: string;
  /** Ledger seq at the last plan write. Used to restore plan on rewind. */
  ledgerSeq?: number;
};

export type PlanTodoCounts = {
  pending: number;
  in_progress: number;
  completed: number;
};

export function emptyThreadPlan(threadId: string): ThreadPlan {
  return {
    threadId,
    goal: '',
    notes: [],
    decisions: [],
    final: null,
    todos: [],
    updatedAt: new Date().toISOString(),
    ledgerSeq: 0,
  };
}

export function isThreadPlanEmpty(
  plan: ThreadPlan | null | undefined,
): boolean {
  if (!plan) return true;
  return (
    !plan.goal.trim() &&
    plan.notes.length === 0 &&
    plan.decisions.length === 0 &&
    !plan.final?.trim() &&
    plan.todos.length === 0
  );
}

export function planTodoCounts(plan: ThreadPlan): PlanTodoCounts {
  const counts: PlanTodoCounts = {
    pending: 0,
    in_progress: 0,
    completed: 0,
  };
  for (const todo of plan.todos) {
    counts[todo.status] += 1;
  }
  return counts;
}

/** True when a locked plan still has pending or in-progress todos. */
export function planHasOpenWork(
  plan: ThreadPlan | null | undefined,
): boolean {
  if (!plan?.final?.trim()) return false;
  const counts = planTodoCounts(plan);
  return counts.pending + counts.in_progress > 0;
}

/**
 * Latest plan written at or before keepThroughSeq. Empty if every revision
 * is newer than the rewind point.
 */
export function selectPlanForRewind(
  revisions: ThreadPlan[],
  keepThroughSeq: number,
  threadId: string,
): ThreadPlan {
  let selected: ThreadPlan | null = null;
  for (const revision of revisions) {
    if ((revision.ledgerSeq ?? 0) <= keepThroughSeq) {
      selected = revision;
    }
  }
  return selected ?? emptyThreadPlan(threadId);
}

export function formatThreadPlanForPrompt(plan: ThreadPlan): string {
  const parts: string[] = [
    '# Thread plan',
    'Brief for THIS thread. Final plan is what to build. Open todos are remaining work.',
  ];

  if (plan.goal.trim()) {
    parts.push('', '## Goal', plan.goal.trim());
  }

  const locked = Boolean(plan.final?.trim());
  if (locked) {
    parts.push('', '## Final plan', plan.final?.trim() ?? '');
  } else {
    if (plan.decisions.length > 0) {
      parts.push('', '## Decisions');
      for (const decision of plan.decisions) {
        parts.push(`- ${decision.text}`);
      }
    }
    const notes = plan.notes.slice(-MAX_PLAN_PROMPT_NOTES);
    if (notes.length > 0) {
      parts.push('', '## Journal');
      for (const note of notes) {
        parts.push(`- [${note.kind}] ${note.text}`);
      }
    }
  }

  if (plan.todos.length > 0) {
    parts.push('', '## Todos');
    for (const todo of plan.todos) {
      const mark =
        todo.status === 'completed'
          ? 'x'
          : todo.status === 'in_progress'
            ? '>'
            : ' ';
      parts.push(`- [${mark}] ${todo.content}`);
    }
  }

  return parts.join('\n');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
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

function parseNotes(value: unknown): PlanNote[] {
  if (!Array.isArray(value)) return [];
  const notes: PlanNote[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const text = typeof rec.text === 'string' ? rec.text.trim() : '';
    if (!id || !text) continue;
    notes.push({
      id,
      at: typeof rec.at === 'string' ? rec.at : '',
      kind: parseNoteKind(rec.kind),
      text,
    });
  }
  return notes.slice(-MAX_PLAN_NOTES);
}

function parseDecisions(value: unknown): PlanDecision[] {
  if (!Array.isArray(value)) return [];
  const decisions: PlanDecision[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const text = typeof rec.text === 'string' ? rec.text.trim() : '';
    if (!id || !text) continue;
    decisions.push({
      id,
      at: typeof rec.at === 'string' ? rec.at : '',
      text,
    });
  }
  return decisions.slice(-MAX_PLAN_DECISIONS);
}

function parseTodos(value: unknown): PlanTodo[] {
  if (!Array.isArray(value)) return [];
  const todos: PlanTodo[] = [];
  for (const item of value) {
    const rec = asRecord(item);
    if (!rec) continue;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    const content = typeof rec.content === 'string' ? rec.content.trim() : '';
    if (!id || !content) continue;
    todos.push({
      id,
      content,
      status: parseTodoStatus(rec.status),
    });
  }
  return todos.slice(0, MAX_PLAN_TODOS);
}

/** Reconstruct a plan from disk/SSE. Corrupt payloads become empty. */
export function parseThreadPlan(raw: unknown, threadId: string): ThreadPlan {
  const empty = emptyThreadPlan(threadId);
  const rec = asRecord(raw);
  if (!rec) return empty;
  const goal = typeof rec.goal === 'string' ? rec.goal : '';
  const final =
    typeof rec.final === 'string' && rec.final.trim() ? rec.final : null;
  return {
    threadId,
    goal,
    notes: parseNotes(rec.notes),
    decisions: parseDecisions(rec.decisions),
    final,
    todos: parseTodos(rec.todos),
    updatedAt:
      typeof rec.updatedAt === 'string' ? rec.updatedAt : empty.updatedAt,
    ledgerSeq:
      typeof rec.ledgerSeq === 'number' && Number.isFinite(rec.ledgerSeq)
        ? rec.ledgerSeq
        : 0,
  };
}

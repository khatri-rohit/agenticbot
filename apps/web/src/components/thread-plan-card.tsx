'use client';

import { useState } from 'react';
import { Check, ChevronDown, Circle, ListTodo, Loader2 } from 'lucide-react';
import {
  isThreadPlanEmpty,
  planTodoCounts,
  type ThreadPlan,
} from '@agent/agent-models';
import { cn } from '@/lib/utils';

/**
 * Live plan card while a run is active: journal + final + todos. Rendered as
 * an overlay above the composer, so it is collapsed by default (slim bar),
 * opaque, and height-capped — it must never read as a transparent popover
 * sitting on the transcript.
 */
export function ThreadPlanCard({ plan }: { plan: ThreadPlan | null }) {
  const [open, setOpen] = useState(false);
  if (!plan || isThreadPlanEmpty(plan)) return null;

  const counts = planTodoCounts(plan);
  const locked = Boolean(plan.final?.trim());
  const label = locked ? 'Plan' : 'Planning';
  const todoHint =
    plan.todos.length > 0 ? `${counts.completed}/${plan.todos.length}` : null;

  return (
    <section
      className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-card shadow-sm"
      aria-label={label}
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ListTodo className="size-3.5 shrink-0 opacity-80" strokeWidth={1.75} />
        <span className="type-ui min-w-0 flex-1 truncate text-foreground/90">
          {plan.goal.trim() || label}
        </span>
        {todoHint ? (
          <span className="type-ui shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {todoHint}
          </span>
        ) : (
          <span className="type-ui shrink-0 text-[11px] text-muted-foreground">
            {locked ? 'Final' : 'Journal'}
          </span>
        )}
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 transition-transform',
            open && 'rotate-180',
          )}
          strokeWidth={1.75}
        />
      </button>
      {open ? (
        <div className="max-h-56 space-y-2 overflow-y-auto border-t border-border/60 px-3 py-2">
          {plan.decisions.length > 0 ? (
            <section>
              <p className="type-ui mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                Decisions
              </p>
              <ul className="space-y-0.5">
                {plan.decisions.map((decision) => (
                  <li
                    key={decision.id}
                    className="type-ui text-[12px] leading-relaxed text-foreground/85"
                  >
                    {decision.text}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {plan.final?.trim() ? (
            <section>
              <p className="type-ui mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                Final plan
              </p>
              <pre className="type-ui max-h-36 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground/85">
                {plan.final}
              </pre>
            </section>
          ) : plan.notes.length > 0 ? (
            <section>
              <p className="type-ui mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                Journal
              </p>
              <ul className="space-y-0.5">
                {plan.notes.slice(-6).map((note) => (
                  <li
                    key={note.id}
                    className="type-ui text-[12px] leading-relaxed text-foreground/85"
                  >
                    <span className="text-muted-foreground">{note.kind}: </span>
                    {note.text}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {plan.todos.length > 0 ? (
            <section>
              <p className="type-ui mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                Todos
              </p>
              <ul className="space-y-1">
                {plan.todos.map((todo) => (
                  <li
                    key={todo.id}
                    className="flex items-start gap-2 text-[12px] leading-relaxed"
                  >
                    <TodoMark status={todo.status} />
                    <span
                      className={cn(
                        'min-w-0 flex-1 text-foreground/85',
                        todo.status === 'completed' &&
                          'text-muted-foreground line-through',
                      )}
                    >
                      {todo.content}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Settled plan pinned under its anchor user message. Collapsed to one line;
 * expands in place on click. Expansion lives in the transcript, so it never
 * moves the composer.
 */
export function PlanChip({ plan }: { plan: ThreadPlan | null }) {
  const [open, setOpen] = useState(false);
  if (!plan || isThreadPlanEmpty(plan)) return null;

  const counts = planTodoCounts(plan);
  const allDone =
    plan.todos.length > 0 && counts.completed === plan.todos.length;

  return (
    <section
      className="min-w-0 overflow-hidden rounded-xl border border-border/60 bg-muted/25"
      aria-label="Plan"
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {allDone ? (
          <Check
            className="size-3.5 shrink-0 text-muted-foreground/70"
            strokeWidth={2}
          />
        ) : (
          <ListTodo
            className="size-3.5 shrink-0 opacity-80"
            strokeWidth={1.75}
          />
        )}
        <span className="type-ui min-w-0 flex-1 truncate text-foreground/90">
          {plan.todos.length > 0
            ? `${counts.completed} of ${plan.todos.length} To-dos${
                allDone ? ' Completed' : ''
              }`
            : 'Plan finalized'}
        </span>
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 transition-transform',
            open && 'rotate-180',
          )}
          strokeWidth={1.75}
        />
      </button>
      {open ? <PlanChipBody plan={plan} /> : null}
    </section>
  );
}

function PlanChipBody({ plan }: { plan: ThreadPlan }) {
  return (
    <div className="max-h-72 space-y-2 overflow-y-auto border-t border-border/60 px-3 py-2">
      {plan.goal.trim() ? (
        <p className="type-ui text-[12px] leading-relaxed text-foreground/85">
          {plan.goal}
        </p>
      ) : null}
      {plan.decisions.length > 0 ? (
        <section>
          <p className="type-ui mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Decisions
          </p>
          <ul className="space-y-0.5">
            {plan.decisions.map((decision) => (
              <li
                key={decision.id}
                className="type-ui text-[12px] leading-relaxed text-foreground/85"
              >
                {decision.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {plan.final?.trim() ? (
        <section>
          <p className="type-ui mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Final plan
          </p>
          <pre className="type-ui whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground/85">
            {plan.final}
          </pre>
        </section>
      ) : null}
      {plan.todos.length > 0 ? (
        <section>
          <p className="type-ui mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
            Todos
          </p>
          <ul className="space-y-1">
            {plan.todos.map((todo) => (
              <li
                key={todo.id}
                className="flex items-start gap-2 text-[12px] leading-relaxed"
              >
                <TodoMark status={todo.status} />
                <span
                  className={cn(
                    'min-w-0 flex-1 text-foreground/85',
                    todo.status === 'completed' &&
                      'text-muted-foreground line-through',
                  )}
                >
                  {todo.content}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function TodoMark({
  status,
}: {
  status: ThreadPlan['todos'][number]['status'];
}) {
  if (status === 'completed') {
    return (
      <Check className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/70" />
    );
  }
  if (status === 'in_progress') {
    return (
      <Loader2 className="mt-0.5 size-3.5 shrink-0 animate-spin text-primary" />
    );
  }
  return (
    <Circle className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/50" />
  );
}

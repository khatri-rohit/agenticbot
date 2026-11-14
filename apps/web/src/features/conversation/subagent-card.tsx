'use client';

import Link from 'next/link';
import { useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronDown,
  Loader2,
  XCircle,
} from 'lucide-react';

import type { SubagentActivity } from './chat-store';
import { cn } from '@/lib/utils';

const PROFILE_LABELS: Record<string, string> = {
  explore: 'Explore',
  review: 'Review',
  advisor: 'Advisor',
};

function formatTokens(tokens: number): string {
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k tok` : `${tokens} tok`;
}

/**
 * Sub-agent delegation card in the turn trail — same column as tools.
 * Running: spinner, live progress, and a full-width link to the child
 * thread's live view. Settled: expandable digest with status badge and
 * iteration/tool-call counts.
 */
/** Settled statuses in words; unknown values fall back to the raw status. */
const SETTLED_STATUS_LABELS: Record<string, string> = {
  completed: 'Done',
  incomplete: 'Stopped early',
  error: 'Failed',
  cancelled: 'Cancelled',
};

export function SubagentCard({ activity }: { activity: SubagentActivity }) {
  const [open, setOpen] = useState(false);
  const running = activity.status === 'running';

  const statusIcon = (() => {
    if (running) return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />;
    if (activity.status === 'completed') return <Check className="size-3.5 shrink-0 text-subtle-foreground" />;
    if (activity.status === 'cancelled') return <XCircle className="size-3.5 shrink-0 text-subtle-foreground" />;
    return <AlertCircle className="size-3.5 shrink-0 text-subtle-foreground" />;
  })();

  const statusLabel = (() => {
    if (running) {
      const calls = activity.toolCalls ?? 0;
      return calls > 0
        ? `${calls} tool${calls === 1 ? '' : 's'}${activity.lastTool ? ` · ${activity.lastTool}` : ''}`
        : 'starting…';
    }
    return SETTLED_STATUS_LABELS[activity.status] ?? activity.status;
  })();

  return (
    <section
      className={cn(
        'min-w-0 max-w-full overflow-hidden rounded-lg border',
        running
          ? 'border-primary/40 bg-primary/5'
          : 'border-border/60 bg-muted/25',
      )}
      aria-label={`Sub-agent ${activity.profile}: ${activity.task}`}
      aria-busy={running}
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        aria-expanded={running ? undefined : open}
        onClick={() => {
          if (!running) setOpen((value) => !value);
        }}
      >
        {statusIcon}
        <span className="type-ui shrink-0 font-medium text-foreground/90">
          {PROFILE_LABELS[activity.profile] ?? activity.profile}
        </span>
        <span className="type-ui min-w-0 flex-1 truncate text-muted-foreground">
          {activity.task}
        </span>
        <span className="type-caption shrink-0 tabular-nums text-muted-foreground">
          {statusLabel}
          {!running && activity.iterations !== undefined
            ? ` · ${activity.iterations}i ${activity.toolCalls ?? 0}t`
            : ''}
          {!running && activity.tokens !== undefined
            ? ` · ${formatTokens(activity.tokens)}`
            : ''}
        </span>
        {!running ? (
          <ChevronDown
            className={cn(
              'size-3.5 shrink-0 transition-transform',
              open && 'rotate-180',
            )}
            strokeWidth={1.75}
          />
        ) : null}
      </button>
      {running && activity.subThreadId ? (
        <Link
          href={`/chat/${activity.subThreadId}`}
          className="type-ui flex w-full items-center justify-between gap-2 border-t border-primary/30 px-3 py-2 text-left text-primary transition-colors hover:bg-primary/10"
        >
          <span className="min-w-0 truncate">View live conversation</span>
          <span aria-hidden="true">→</span>
        </Link>
      ) : null}
      {!running && open ? (
        <div className="space-y-2 border-t border-border/60 px-3 py-2">
          {activity.summary ? (
            <pre className="type-ui max-h-64 overflow-auto whitespace-pre-wrap break-words leading-relaxed text-foreground/85">
              {activity.summary}
            </pre>
          ) : null}
          {activity.subThreadId ? (
            <Link
              href={`/chat/${activity.subThreadId}`}
              className="type-ui text-primary hover:underline"
            >
              View conversation <span aria-hidden="true">→</span>
            </Link>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * Lean in-flow line for a live delegate: one muted row in the same language
 * as the tool group rows (profile + objective + live counter, pulse sweep on
 * the task text). The full-width live link and progress live in the
 * SubagentLiveStrip above the composer, not in the reading path.
 */
export function SubagentLiveLine({ activity }: { activity: SubagentActivity }) {
  const label = PROFILE_LABELS[activity.profile] ?? activity.profile;
  const calls = activity.toolCalls ?? 0;
  return (
    <div
      className="flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2"
      aria-label={`Sub-agent ${label}: ${activity.task}`}
      aria-busy
    >
      <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
      <span className="type-ui shrink-0 font-medium text-foreground/90">
        {label}
      </span>
      <span className="tool-running type-ui min-w-0 flex-1 truncate text-muted-foreground">
        {activity.task}
      </span>
      <span className="type-caption shrink-0 tabular-nums text-muted-foreground">
        {calls > 0
          ? `${calls} tool${calls === 1 ? '' : 's'}${activity.lastTool ? ` · ${activity.lastTool}` : ''}`
          : 'starting…'}
      </span>
    </div>
  );
}

/**
 * Running sub-agents above the composer — same container language as
 * ThreadPlanCard (rounded card, slim rows, overlays via absolute so the
 * composer height never changes). One row per live delegate: profile,
 * objective, live tool counter, and the link to the child thread's live view.
 * Settled delegates never render here; the transcript keeps their digest.
 */
export function SubagentLiveStrip({
  activities,
}: {
  activities: SubagentActivity[] | undefined;
}) {
  const running = activities?.filter((item) => item.status === 'running') ?? [];
  if (running.length === 0) return null;

  return (
    <section
      className="min-w-0 overflow-hidden rounded-lg border border-border/60 bg-card shadow-sm"
      aria-label="Running sub-agents"
    >
      {running.map((item) => {
        const label = PROFILE_LABELS[item.profile] ?? item.profile;
        const calls = item.toolCalls ?? 0;
        return (
          <div
            key={item.subRunId}
            className="flex min-w-0 items-center gap-2 px-3 py-2"
            aria-busy
          >
            <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
            <span className="type-ui shrink-0 font-medium text-foreground/90">
              {label}
            </span>
            <span className="tool-running type-ui min-w-0 flex-1 truncate text-muted-foreground">
              {item.task}
            </span>
            <span className="type-caption shrink-0 tabular-nums text-muted-foreground">
              {calls > 0
                ? `${calls} tool${calls === 1 ? '' : 's'}${item.lastTool ? ` · ${item.lastTool}` : ''}`
                : 'starting…'}
            </span>
            {item.subThreadId ? (
              <Link
                href={`/chat/${item.subThreadId}`}
                className="type-ui shrink-0 text-primary hover:underline"
              >
                View live conversation{' '}
                <span aria-hidden="true">→</span>
              </Link>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
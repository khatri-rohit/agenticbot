'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import {
  AlertCircle,
  Check,
  ChevronDown,
  Loader2,
  XCircle,
} from 'lucide-react';

import type { SubagentActivity } from '../features/agent/store/chat-store';
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
 * Running: spinner + clickable link to child thread. Settled: expandable
 * digest with status badge and iteration/tool-call counts.
 */
export function SubagentCard({ activity }: { activity: SubagentActivity }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const running = activity.status === 'running';

  const statusIcon = (() => {
    if (running) return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />;
    if (activity.status === 'completed') return <Check className="size-3.5 shrink-0 text-muted-foreground/70" />;
    if (activity.status === 'cancelled') return <XCircle className="size-3.5 shrink-0 text-muted-foreground/70" />;
    return <AlertCircle className="size-3.5 shrink-0 text-muted-foreground/70" />;
  })();

  const statusLabel = (() => {
    if (running) {
      const calls = activity.toolCalls ?? 0;
      return calls > 0
        ? `${calls} tool${calls === 1 ? '' : 's'}${activity.lastTool ? ` · ${activity.lastTool}` : ''}`
        : 'starting…';
    }
    return activity.status;
  })();

  return (
    <section
      className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border/60 bg-muted/25"
      aria-label={`Sub-agent ${activity.profile}: ${activity.task}`}
      aria-busy={running}
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        aria-expanded={open}
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
      {!running && open ? (
        <div className="space-y-2 border-t border-border/60 px-3 py-2">
          {activity.summary ? (
            <pre className="type-ui max-h-64 overflow-auto whitespace-pre-wrap break-words leading-relaxed text-foreground/85">
              {activity.summary}
            </pre>
          ) : null}
          {activity.subThreadId ? (
            <button
              type="button"
              className="type-ui text-primary hover:underline"
              onClick={() => router.push(`/chat/${activity.subThreadId}`)}
            >
              View conversation →
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
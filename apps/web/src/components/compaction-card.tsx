'use client';

import { useState } from 'react';
import { Check, ChevronDown, Layers, Loader2 } from 'lucide-react';

import type { CompactionNotice } from '../features/agent/store/chat-store';
import { cn } from '@/lib/utils';

/**
 * Compaction step in the turn trail — same column as tools, not ToolStepList.
 * Running: spinner like a live tool. Done: expandable brief/summary.
 */
export function CompactionCard({ notice }: { notice: CompactionNotice }) {
  const [open, setOpen] = useState(false);
  const running = notice.status === 'running';

  return (
    <section
      className="min-w-0 max-w-full overflow-hidden rounded-xl border border-border/60 bg-muted/25"
      aria-label={running ? 'Compacting context' : 'Context compacted'}
      aria-busy={running}
    >
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
        aria-expanded={open}
        disabled={running}
        onClick={() => {
          if (!running) setOpen((value) => !value);
        }}
      >
        {running ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <Check className="size-3.5 shrink-0 text-muted-foreground/70" />
        )}
        <Layers className="size-3.5 shrink-0 opacity-80" strokeWidth={1.75} />
        <span className="type-ui min-w-0 flex-1 truncate text-foreground/90">
          {running ? 'Compacting context…' : 'Context compacted'}
        </span>
        {!running && notice.throughSeq > 0 ? (
          <span className="type-ui shrink-0 text-[11px] tabular-nums text-muted-foreground">
            through seq {notice.throughSeq}
          </span>
        ) : null}
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
          {notice.brief.trim() ? (
            <section className="min-w-0">
              <p className="type-ui mb-1 font-medium text-muted-foreground">
                Brief
              </p>
              <pre className="type-ui max-h-40 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground/85">
                {notice.brief}
              </pre>
            </section>
          ) : null}
          {notice.summary.trim() ? (
            <section className="min-w-0">
              <p className="type-ui mb-1 font-medium text-muted-foreground">
                Summary
              </p>
              <pre className="type-ui max-h-64 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground/85">
                {notice.summary}
              </pre>
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

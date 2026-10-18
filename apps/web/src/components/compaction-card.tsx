'use client';

import { useState } from 'react';
import { ChevronDown, Layers } from 'lucide-react';

import type { CompactionNotice } from '../features/agent/store/chat-store';
import { cn } from '@/lib/utils';

/**
 * Host compaction notice — separate from the tool trail.
 * Shows the extractive brief/summary written into snapshot.json.
 */
export function CompactionCard({ notice }: { notice: CompactionNotice }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-w-0 rounded-lg border border-border/50 bg-muted/25 px-3 py-2">
      <button
        type="button"
        className="flex w-full min-w-0 items-center gap-2 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Layers className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <span className="type-ui min-w-0 flex-1 truncate text-xs font-medium text-foreground/90">
          Context compacted
        </span>
        <span className="type-ui shrink-0 text-[11px] text-muted-foreground">
          through seq {notice.throughSeq}
        </span>
        <ChevronDown
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
          strokeWidth={1.75}
        />
      </button>
      {open ? (
        <div className="mt-2 space-y-2 border-t border-border/40 pt-2">
          {notice.brief.trim() ? (
            <section className="min-w-0">
              <p className="type-ui mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                Brief
              </p>
              <pre className="type-ui max-h-40 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground/85">
                {notice.brief}
              </pre>
            </section>
          ) : null}
          {notice.summary.trim() ? (
            <section className="min-w-0">
              <p className="type-ui mb-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                Summary
              </p>
              <pre className="type-ui max-h-64 overflow-auto whitespace-pre-wrap break-words text-[12px] leading-relaxed text-foreground/85">
                {notice.summary}
              </pre>
            </section>
          ) : null}
        </div>
      ) : notice.brief.trim() ? (
        <p className="type-ui mt-1 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">
          {notice.brief}
        </p>
      ) : null}
    </div>
  );
}

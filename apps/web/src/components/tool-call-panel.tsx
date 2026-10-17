'use client';

import { useMemo, useState } from 'react';
import { Check, ChevronDown, Copy, Loader2, X } from 'lucide-react';
import type { Message } from '@org/agent-models';
import type { ToolActivity } from '../features/agent/store/chat-store';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

export type ToolCallRow = {
  toolCallId: string;
  toolName: string;
  /** Raw JSON arguments from the assistant tool call, if known. */
  args?: string;
  /** Full tool result body from the ledger, if known. */
  result?: string;
  status: 'running' | 'done' | 'failed';
  durationMs?: number;
};

export const MAX_PANEL_PX = 288; // h-72 — fixed length, scroll inside

/**
 * Build one row per assistant tool call in the turn. Durable ledger messages
 * supply name/args/result; the live toolActivity SSE overlay supplies status
 * (and rows for calls whose ledger messages have not hydrated yet).
 */
export function buildToolCallRows(
  replies: Message[],
  liveActivity: ToolActivity[],
): ToolCallRow[] {
  const rows = new Map<string, ToolCallRow>();

  for (const message of replies) {
    if (message.role === 'assistant' && message.toolCalls) {
      for (const call of message.toolCalls) {
        if (!rows.has(call.id)) {
          rows.set(call.id, {
            toolCallId: call.id,
            toolName: call.function.name,
            args: call.function.arguments,
            status: 'running',
          });
        }
      }
    }
    if (message.role === 'tool' && message.toolCallId) {
      const existing = rows.get(message.toolCallId);
      const row: ToolCallRow = existing ?? {
        toolCallId: message.toolCallId,
        toolName: 'tool',
        status: message.status === 'interrupted' ? 'failed' : 'done',
      };
      row.result = message.content;
      if (!existing || row.status !== 'failed') {
        row.status = message.status === 'interrupted' ? 'failed' : 'done';
      }
      rows.set(message.toolCallId, row);
    }
  }

  // Live overlay wins on status; appends activity not yet in the ledger.
  for (const activity of liveActivity) {
    const existing = rows.get(activity.toolCallId);
    if (existing) {
      existing.status = activity.status;
      existing.durationMs = activity.durationMs ?? existing.durationMs;
    } else {
      rows.set(activity.toolCallId, {
        toolCallId: activity.toolCallId,
        toolName: activity.toolName,
        status: activity.status,
        durationMs: activity.durationMs,
      });
    }
  }

  // Map preserves insertion order = execution order.
  return [...rows.values()];
}

function formatArgsPreview(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) return '';
  const oneLine = trimmed.replace(/\s+/g, ' ');
  return oneLine.length > 96 ? `${oneLine.slice(0, 96)}…` : oneLine;
}

function prettyJson(raw: string): string | null {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return null;
  }
}

export function ToolCallPanel({
  replies,
  liveActivity,
}: {
  replies: Message[];
  liveActivity: ToolActivity[];
}) {
  const rows = useMemo(
    () => buildToolCallRows(replies, liveActivity),
    [replies, liveActivity],
  );
  const [expanded, setExpanded] = useState(true);

  if (rows.length === 0) return null;

  const runningCount = rows.filter((row) => row.status === 'running').length;
  const failedCount = rows.filter((row) => row.status === 'failed').length;

  return (
    <section
      className="overflow-hidden rounded-lg border border-border/60 bg-muted/30"
      aria-label={`Tool calls (${rows.length})`}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      >
        {runningCount > 0 ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : (
          <Check
            className={cn(
              'size-3.5 shrink-0',
              failedCount > 0 ? 'text-destructive' : 'text-muted-foreground/70',
            )}
          />
        )}
        <span>
          Tools
          <span className="ml-1.5 tabular-nums">
            {rows.length}
            {runningCount > 0 ? ` · ${runningCount} running` : ''}
            {failedCount > 0 ? ` · ${failedCount} failed` : ''}
          </span>
        </span>
        <ChevronDown
          className={cn(
            'ml-auto size-3.5 shrink-0 transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {expanded ? (
        <ScrollArea
          className="border-t border-border/60"
          style={{ height: Math.min(MAX_PANEL_PX, rows.length * 44 - 10) }}
        >
          <ul role="list" className="divide-y divide-border/40">
            {rows.map((row) => (
              <ToolCallRowItem key={row.toolCallId} row={row} />
            ))}
          </ul>
        </ScrollArea>
      ) : null}
    </section>
  );
}

function ToolCallRowItem({ row }: { row: ToolCallRow }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const copyResult = async () => {
    if (!row.result) return;
    try {
      await navigator.clipboard.writeText(row.result);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard denied */
    }
  };

  const argsPreview = row.args ? formatArgsPreview(row.args) : '';
  const resultPretty = useMemo(
    () => (row.args ? prettyJson(row.args) : null),
    [row.args],
  );

  return (
    <li className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/30"
      >
        {row.status === 'running' ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : row.status === 'failed' ? (
          <X className="size-3.5 shrink-0 text-destructive" />
        ) : (
          <Check className="size-3.5 shrink-0 text-muted-foreground/70" />
        )}
        <span className="shrink-0 font-mono text-xs text-foreground">
          {row.toolName}
        </span>
        {argsPreview ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {argsPreview}
          </span>
        ) : (
          <span className="min-w-0 flex-1 text-[11px] italic text-muted-foreground/60">
            {row.status === 'running' ? 'waiting for args…' : ''}
          </span>
        )}
        {row.durationMs !== undefined ? (
          <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/70">
            {row.durationMs}ms
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="flex flex-col gap-2 border-t border-border/40 bg-background/40 px-3 py-2">
          {row.args ? (
            <div>
              <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                Arguments
              </p>
              <ScrollArea className="h-36 max-h-36 rounded border border-border/50 bg-muted/20">
                <pre className="whitespace-pre-wrap px-2 py-1.5 text-[11px] leading-relaxed text-foreground">
                  {resultPretty ?? row.args}
                </pre>
              </ScrollArea>
            </div>
          ) : null}
          {row.result ? (
            <div>
              <div className="mb-1 flex items-center justify-between">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  Result
                </p>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-5 gap-1 px-1.5 text-[10px] text-muted-foreground"
                  onClick={() => void copyResult()}
                >
                  {copied ? (
                    <Check className="size-2.5" aria-hidden />
                  ) : (
                    <Copy className="size-2.5" aria-hidden />
                  )}
                  {copied ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <ScrollArea className="h-40 max-h-40 rounded border border-border/50 bg-muted/20">
                <pre className="whitespace-pre-wrap px-2 py-1.5 text-[11px] leading-relaxed text-foreground">
                  {row.result}
                </pre>
              </ScrollArea>
            </div>
          ) : row.status === 'running' ? (
            <p className="text-[11px] italic text-muted-foreground/60">
              Running…
            </p>
          ) : (
            <p className="text-[11px] italic text-muted-foreground/60">
              No result captured.
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

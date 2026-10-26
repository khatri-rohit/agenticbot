'use client';

import { useEffect, useState } from 'react';
import {
  Ban,
  Check,
  ChevronDown,
  Copy,
  FilePenLine,
  FileSearch,
  FileText,
  Loader2,
  Search,
  SquareTerminal,
  Wrench,
  X,
} from 'lucide-react';
import type { ToolCallRow } from '../lib/turn-timeline';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type { ToolCallRow };

type ToolKind = 'file' | 'search' | 'terminal' | 'other';

type ToolSummary = {
  kind: ToolKind;
  title: string;
  action: string;
  plus?: number;
  minus?: number;
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseArgs(raw?: string): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* truncated live previews are not always JSON */
  }
  return {};
}

function fileNameFromPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  const parts = trimmed.replaceAll('\\', '/').split('/').filter(Boolean);
  return parts.at(-1) ?? trimmed;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split('\n').length;
}

export function summarizeToolRow(row: ToolCallRow): ToolSummary {
  const args = parseArgs(row.args);
  switch (row.toolName) {
    case 'read_file': {
      const path = asString(args.path);
      return {
        kind: 'file',
        title: fileNameFromPath(path) || path || 'file',
        action: 'Read',
      };
    }
    case 'edit_file': {
      const path = asString(args.path);
      const oldText = asString(args.oldText);
      const newText = asString(args.newText);
      const intent = asString(args.intent);
      const resultLine = (row.result ?? '').split('\n')[0] ?? '';
      let action = 'Writing';
      if (resultLine.startsWith('Created ')) action = 'Create';
      else if (resultLine.startsWith('Patched ')) action = 'Edit';
      else if (intent === 'create') action = 'Create';
      else if (intent === 'patch') action = 'Edit';
      else if (oldText) action = 'Edit';
      else if (row.status !== 'running' && 'newText' in args && !oldText) {
        action = 'Create';
      }
      return {
        kind: 'file',
        title: fileNameFromPath(path) || path || 'file',
        action,
        plus: newText ? countLines(newText) : undefined,
        minus: oldText ? countLines(oldText) : undefined,
      };
    }
    case 'glob':
      return {
        kind: 'search',
        title: asString(args.pattern) || '**/*',
        action: 'Glob',
      };
    case 'grep':
      return {
        kind: 'search',
        title: asString(args.pattern) || 'search',
        action: 'Grep',
      };
    case 'run_terminal':
      return {
        kind: 'terminal',
        title: asString(args.command) || 'command',
        action: 'Terminal',
      };
    case 'web_search':
      return {
        kind: 'search',
        title: asString(args.query) || 'search',
        action: 'Search',
      };
    case 'web_fetch':
      return {
        kind: 'other',
        title: asString(args.url) || 'fetch',
        action: 'Fetch',
      };
    case 'plan': {
      const action = asString(args.action) || 'plan';
      const text = asString(args.text);
      return {
        kind: 'other',
        title: text || action,
        action: action === 'set_goal' ? 'Goal' : 'Plan',
      };
    }
    case 'todo':
      return {
        kind: 'other',
        title: 'checklist',
        action: 'Todos',
      };
    case 'offer_choice':
      return {
        kind: 'other',
        title: asString(args.question) || 'choice',
        action: 'Choice',
      };
    default:
      return { kind: 'other', title: row.toolName, action: row.toolName };
  }
}

function KindIcon({
  kind,
  action,
  className,
}: {
  kind: ToolKind;
  action: string;
  className?: string;
}) {
  const shared = cn('size-3.5 shrink-0', className);
  if (kind === 'terminal') return <SquareTerminal className={shared} />;
  if (kind === 'search') return <Search className={shared} />;
  if (kind === 'file' && action === 'Read')
    return <FileText className={shared} />;
  if (kind === 'file' && action === 'Edit')
    return <FilePenLine className={shared} />;
  if (kind === 'file') return <FileSearch className={shared} />;
  return <Wrench className={shared} />;
}

function StatusIcon({ status }: { status: ToolCallRow['status'] }) {
  if (status === 'running') {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />;
  }
  if (status === 'failed') {
    return <X className="size-3.5 shrink-0 text-destructive" />;
  }
  if (status === 'skipped') {
    return <Ban className="size-3.5 shrink-0 text-muted-foreground/70" />;
  }
  return <Check className="size-3.5 shrink-0 text-muted-foreground/70" />;
}

/** Render one tools step from the turn timeline (collapsible trail for both modes). */
export function ToolStepList({
  rows,
  variant = 'home',
}: {
  rows: ToolCallRow[];
  variant?: 'home' | 'workspace';
}) {
  if (rows.length === 0) return null;
  return <ToolTrail rows={rows} variant={variant} />;
}

/**
 * Shared tool trail: collapses when idle; stays open while any tool is running
 * so the active step stays visible without drowning the transcript.
 */
function ToolTrail({
  rows,
  variant,
}: {
  rows: ToolCallRow[];
  variant: 'home' | 'workspace';
}) {
  const runningCount = rows.filter((row) => row.status === 'running').length;
  const failedCount = rows.filter((row) => row.status === 'failed').length;
  const skippedCount = rows.filter((row) => row.status === 'skipped').length;
  const [expanded, setExpanded] = useState(true);
  const [userToggled, setUserToggled] = useState(false);

  useEffect(() => {
    if (userToggled) return;
    setExpanded(runningCount > 0 || rows.length <= 3);
  }, [runningCount, rows.length, userToggled]);

  const label =
    variant === 'workspace'
      ? `Workspace tools (${rows.length})`
      : `Tool calls (${rows.length})`;

  return (
    <section
      className="min-w-0 max-w-full overflow-hidden rounded-xl border border-border/60 bg-muted/25"
      aria-label={label}
    >
      <button
        type="button"
        onClick={() => {
          setUserToggled(true);
          setExpanded((prev) => !prev);
        }}
        aria-expanded={expanded}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs font-medium text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
      >
        <StatusIcon
          status={
            runningCount > 0
              ? 'running'
              : failedCount > 0
                ? 'failed'
                : skippedCount > 0
                  ? 'skipped'
                  : 'done'
          }
        />
        <span className="min-w-0 truncate">
          Tools
          <span className="ml-1.5 tabular-nums">
            {rows.length}
            {runningCount > 0 ? ` · ${runningCount} running` : ''}
            {failedCount > 0 ? ` · ${failedCount} failed` : ''}
            {skippedCount > 0 ? ` · ${skippedCount} skipped` : ''}
          </span>
        </span>
        <ChevronDown
          className={cn(
            'ml-auto size-3.5 shrink-0 transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>
      {/* Rows stay mounted across group collapse so each row's own open
          state survives; hiding is CSS, not unmounting. */}
      <ul
        role="list"
        className={cn(
          'divide-y divide-border/40',
          expanded && 'border-t border-border/60',
        )}
        hidden={!expanded}
      >
        {rows.map((row) => (
          <ToolCard
            key={row.toolCallId}
            row={row}
            flush
            visible={expanded}
            defaultOpen={row.status === 'running'}
          />
        ))}
      </ul>
    </section>
  );
}

function ToolCard({
  row,
  flush = false,
  defaultOpen = false,
  /** False while the parent group is collapsed: auto-open pauses so an
   *  invisible row can't spring open on group re-expand. */
  visible = true,
}: {
  row: ToolCallRow;
  flush?: boolean;
  defaultOpen?: boolean;
  visible?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);
  const summary = summarizeToolRow(row);

  useEffect(() => {
    if (visible && row.status === 'running') setOpen(true);
  }, [visible, row.status]);

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

  return (
    <li
      className={cn(
        'min-w-0 max-w-full',
        !flush &&
          'overflow-hidden rounded-xl border border-border/50 bg-muted/30',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/30"
      >
        <KindIcon
          kind={summary.kind}
          action={summary.action}
          className="text-muted-foreground"
        />
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/80">
          {summary.action}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
          {summary.title}
        </span>
        {summary.minus !== undefined ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-red-500/90">
            −{summary.minus}
          </span>
        ) : null}
        {summary.plus !== undefined ? (
          <span className="shrink-0 font-mono text-[11px] tabular-nums text-emerald-600 dark:text-emerald-400">
            +{summary.plus}
          </span>
        ) : null}
        {row.durationMs !== undefined && row.status !== 'running' ? (
          <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground/70">
            {row.durationMs}ms
          </span>
        ) : null}
        <StatusIcon status={row.status} />
      </button>

      {open ? (
        <div className="min-w-0 space-y-2 border-t border-border/40 bg-background/40 px-3 py-2">
          {row.result ? (
            <div className="min-w-0">
              <div className="mb-1 flex items-center justify-between gap-2">
                <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
                  Output
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
              <pre className="max-h-56 min-w-0 overflow-x-auto overflow-y-auto whitespace-pre-wrap break-all rounded-lg bg-muted/20 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground/90 ring-1 ring-border/40">
                {row.result}
              </pre>
            </div>
          ) : row.status === 'running' ? (
            <p className="text-[11px] italic text-muted-foreground/60">
              Running…
            </p>
          ) : (
            <p className="text-[11px] italic text-muted-foreground/60">
              No output captured.
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

'use client';

import { useState } from 'react';
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

/**
 * Render each tool call as its own inline card in the stream. No group
 * accordion: every row is independently collapsible, so the user always sees
 * what the agent is doing without expanding a wrapper first.
 */
export function ToolStepList({ rows }: { rows: ToolCallRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {rows.map((row) => (
        <ToolCard key={row.toolCallId} row={row} />
      ))}
    </div>
  );
}

/**
 * One tool call. Collapsed = fixed height (header + clipped content teaser +
 * bottom bar with a centered chevron) so the user gets a sense of what the
 * tool is doing without expanding. Expanded = full per-type preview between
 * header and bottom bar, capped at 60vh with an internal scrollbar. Cards
 * start collapsed whether running or settled — the user opens one on click
 * when they want detail, so a live stream of tool activity doesn't balloon
 * the transcript or fight the scroll.
 */
function ToolCard({ row }: { row: ToolCallRow }) {
  const [open, setOpen] = useState(false);

  const summary = summarizeToolRow(row);
  const toggle = () => setOpen((prev) => !prev);

  return (
    <article
      className="min-w-0 max-w-full overflow-hidden rounded-xl border border-border/50 bg-muted/30"
      aria-label={`${summary.action}: ${summary.title}`}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/30"
      >
        <KindIcon
          kind={summary.kind}
          action={summary.action}
          className="text-muted-foreground"
        />
        <span className="type-caption shrink-0 font-medium text-muted-foreground/80">
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
        <div className="min-w-0 max-h-[60vh] overflow-y-auto overflow-x-auto border-t border-border/40 bg-background/40">
          <ToolPreview row={row} summary={summary} />
        </div>
      ) : (
        <div className="relative min-w-0 max-h-24 overflow-hidden border-t border-border/40 bg-background/40">
          <ToolPreview row={row} summary={summary} />
          {/* Fade-to-edge so the clipped teaser reads as "more below — expand". */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-background/90 to-transparent" />
        </div>
      )}

      {/* Bottom bar: always visible, holds the centered expand affordance so
          the click target is identical in both states. */}
      <div className="flex items-center justify-center border-t border-border/40 bg-muted/20 py-0.5">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-label={open ? 'Collapse' : 'Expand'}
          className="flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <ChevronDown
            className={cn(
              'size-3 shrink-0 transition-transform',
              open && 'rotate-180',
            )}
          />
        </button>
      </div>
    </article>
  );
}

/** Per-type preview body. Picks a renderer by tool name; falls back to a
 *  generic args + result view. All renderers share the 60vh scroll cap. */
function ToolPreview({
  row,
  summary,
}: {
  row: ToolCallRow;
  summary: ToolSummary;
}) {
  switch (row.toolName) {
    case 'read_file':
      return <FileReadPreview row={row} />;
    case 'edit_file':
      return <EditFilePreview row={row} summary={summary} />;
    case 'run_terminal':
      return <TerminalPreview row={row} />;
    case 'glob':
    case 'grep':
    case 'web_search':
      return <SearchPreview row={row} />;
    case 'web_fetch':
      return <WebFetchPreview row={row} />;
    default:
      return <GenericPreview row={row} />;
  }
}

/* ---------- per-type preview renderers ---------- */

const PREVIEW_SCROLL = 'overflow-x-auto';

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard denied */
    }
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-5 gap-1 px-1.5 text-[10px] text-muted-foreground"
      onClick={() => void copy()}
    >
      {copied ? (
        <Check className="size-2.5" aria-hidden />
      ) : (
        <Copy className="size-2.5" aria-hidden />
      )}
      {copied ? 'Copied' : label}
    </Button>
  );
}

function PreviewHeader({
  label,
  onCopy,
}: {
  label: string;
  onCopy?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-3 pt-2">
      <p className="type-caption font-medium text-muted-foreground/70">
        {label}
      </p>
      {onCopy}
    </div>
  );
}

/** read_file: full file content with a line-number gutter. */
function FileReadPreview({ row }: { row: ToolCallRow }) {
  const content = row.result ?? '';
  if (!content) {
    return (
      <p className="px-3 py-2 text-[11px] italic text-muted-foreground/60">
        {row.status === 'running' ? 'Reading…' : 'No output captured.'}
      </p>
    );
  }
  const lines = content.split('\n');
  return (
    <div className="min-w-0">
      <PreviewHeader
        label={`File · ${lines.length} lines`}
        onCopy={<CopyButton text={content} />}
      />
      <pre
        className={cn(
          PREVIEW_SCROLL,
          'm-0 min-w-0 whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground/90',
        )}
      >
        {lines.map((line, i) => (
          <span key={i} className="block">
            <span className="mr-3 inline-block w-8 shrink-0 select-none text-right text-muted-foreground/40 tabular-nums">
              {i + 1}
            </span>
            <span>{line}</span>
          </span>
        ))}
      </pre>
    </div>
  );
}

/** edit_file: oldText (−) / newText (+) blocks. While running and args lack
 *  the full text, show an "Editing {path}…" placeholder — the live event
 *  strips edit_file args to {path,intent} by design. */
function EditFilePreview({
  row,
  summary,
}: {
  row: ToolCallRow;
  summary: ToolSummary;
}) {
  const args = parseArgs(row.args);
  const oldText = asString(args.oldText);
  const newText = asString(args.newText);
  const path = asString(args.path) || summary.title;

  if (row.status === 'running' && !oldText && !newText) {
    return (
      <p className="px-3 py-2 text-[11px] italic text-muted-foreground/60">
        Editing {path}…
      </p>
    );
  }

  const oldLines = oldText ? oldText.split('\n') : [];
  const newLines = newText ? newText.split('\n') : [];

  return (
    <div className="min-w-0 space-y-2 px-3 py-2">
      {oldLines.length > 0 ? (
        <div className="min-w-0">
          <PreviewHeader
            label={`Removed · ${oldLines.length} lines`}
            onCopy={<CopyButton text={oldText} label="Copy old" />}
          />
          <pre
            className={cn(
              PREVIEW_SCROLL,
              'm-0 min-w-0 whitespace-pre-wrap break-words rounded-lg bg-red-500/5 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-red-600 dark:text-red-400 ring-1 ring-red-500/20',
            )}
          >
            {oldLines.map((line, i) => (
              <span key={i} className="block">
                <span className="mr-2 select-none text-red-500/70">−</span>
                {line}
              </span>
            ))}
          </pre>
        </div>
      ) : null}
      {newLines.length > 0 ? (
        <div className="min-w-0">
          <PreviewHeader
            label={`Added · ${newLines.length} lines`}
            onCopy={<CopyButton text={newText} label="Copy new" />}
          />
          <pre
            className={cn(
              PREVIEW_SCROLL,
              'm-0 min-w-0 whitespace-pre-wrap break-words rounded-lg bg-emerald-500/5 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-emerald-700 dark:text-emerald-400 ring-1 ring-emerald-500/20',
            )}
          >
            {newLines.map((line, i) => (
              <span key={i} className="block">
                <span className="mr-2 select-none text-emerald-500/70">+</span>
                {line}
              </span>
            ))}
          </pre>
        </div>
      ) : null}
      {oldLines.length === 0 && newLines.length === 0 ? (
        <p className="text-[11px] italic text-muted-foreground/60">
          {row.result || 'No diff available.'}
        </p>
      ) : null}
    </div>
  );
}

/** run_terminal: dark block with `$ command` then output. While running,
 *  shows the command and a "Running…" line; output fills on completion. */
function TerminalPreview({ row }: { row: ToolCallRow }) {
  const args = parseArgs(row.args);
  const command = asString(args.command) || (row.result?.split('\n')[0] ?? '');
  const output =
    row.result && row.status !== 'running'
      ? row.result
      : row.status === 'running'
        ? ''
        : row.result ?? '';

  return (
    <div className="min-w-0 px-3 py-2">
      <PreviewHeader
        label="Terminal"
        onCopy={output ? <CopyButton text={output} /> : undefined}
      />
      <pre
        className={cn(
          PREVIEW_SCROLL,
          'm-0 min-w-0 whitespace-pre-wrap break-words rounded-lg bg-zinc-950 px-2.5 py-2 font-mono text-[11px] leading-relaxed text-zinc-200 ring-1 ring-zinc-800',
        )}
      >
        <span className="block text-emerald-400">
          <span className="mr-1 select-none text-zinc-500">$</span>
          {command}
        </span>
        {row.status === 'running' ? (
          <span className="mt-1 flex items-center gap-1.5 text-zinc-400">
            <Loader2 className="size-3 animate-spin" />
            Running…
          </span>
        ) : output ? (
          <span className="mt-1 block text-zinc-300">{output}</span>
        ) : (
          <span className="mt-1 block text-zinc-500">No output.</span>
        )}
      </pre>
    </div>
  );
}

/** glob / grep / web_search: pattern/query + result lines. */
function SearchPreview({ row }: { row: ToolCallRow }) {
  const args = parseArgs(row.args);
  const pattern =
    asString(args.pattern) || asString(args.query) || row.toolName;
  const result = row.result ?? '';
  const resultLines = result ? result.split('\n').filter(Boolean) : [];

  return (
    <div className="min-w-0 px-3 py-2">
      <PreviewHeader
        label={`${pattern} · ${resultLines.length} results`}
        onCopy={result ? <CopyButton text={result} /> : undefined}
      />
      {result ? (
        <pre
          className={cn(
            PREVIEW_SCROLL,
            'm-0 min-w-0 whitespace-pre-wrap break-words px-1 py-1 font-mono text-[11px] leading-relaxed text-foreground/90',
          )}
        >
          {result}
        </pre>
      ) : row.status === 'running' ? (
        <p className="text-[11px] italic text-muted-foreground/60">Searching…</p>
      ) : (
        <p className="text-[11px] italic text-muted-foreground/60">
          No results.
        </p>
      )}
    </div>
  );
}

/** web_fetch: URL + fetched content. */
function WebFetchPreview({ row }: { row: ToolCallRow }) {
  const args = parseArgs(row.args);
  const url = asString(args.url) || row.toolName;
  const content = row.result ?? '';

  return (
    <div className="min-w-0 px-3 py-2">
      <PreviewHeader
        label={url}
        onCopy={content ? <CopyButton text={content} /> : undefined}
      />
      {content ? (
        <pre
          className={cn(
            PREVIEW_SCROLL,
            'm-0 min-w-0 whitespace-pre-wrap break-words px-1 py-1 font-mono text-[11px] leading-relaxed text-foreground/90',
          )}
        >
          {content}
        </pre>
      ) : row.status === 'running' ? (
        <p className="text-[11px] italic text-muted-foreground/60">Fetching…</p>
      ) : (
        <p className="text-[11px] italic text-muted-foreground/60">
          No content.
        </p>
      )}
    </div>
  );
}

/** plan / todo / offer_choice / default: raw args + result. These tools have
 *  dedicated settled-state cards elsewhere in the UI; this shows the raw call. */
function GenericPreview({ row }: { row: ToolCallRow }) {
  const args = row.args ?? '';
  const result = row.result ?? '';

  return (
    <div className="min-w-0 space-y-2 px-3 py-2">
      {args ? (
        <div className="min-w-0">
          <PreviewHeader label="Args" onCopy={<CopyButton text={args} />} />
          <pre
            className={cn(
              PREVIEW_SCROLL,
              'm-0 min-w-0 whitespace-pre-wrap break-words px-1 py-1 font-mono text-[11px] leading-relaxed text-foreground/90',
            )}
          >
            {args}
          </pre>
        </div>
      ) : null}
      {result ? (
        <div className="min-w-0">
          <PreviewHeader
            label="Output"
            onCopy={<CopyButton text={result} />}
          />
          <pre
            className={cn(
              PREVIEW_SCROLL,
              'm-0 min-w-0 whitespace-pre-wrap break-words px-1 py-1 font-mono text-[11px] leading-relaxed text-foreground/90',
            )}
          >
            {result}
          </pre>
        </div>
      ) : row.status === 'running' ? (
        <p className="text-[11px] italic text-muted-foreground/60">Running…</p>
      ) : (
        <p className="text-[11px] italic text-muted-foreground/60">
          No output captured.
        </p>
      )}
    </div>
  );
}

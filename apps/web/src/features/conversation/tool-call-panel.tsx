'use client';

import { useMemo, useState } from 'react';
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
import { parseSubagentHeader, subagentDigestBody } from '@agent/agent-models';
import type { ToolCallRow } from './turn-timeline';
import { SubagentCard } from './subagent-card';
import type { SubagentActivity } from './chat-store';
import { Button } from '@/components/ui/button';
import { toastError } from '@/hooks/use-toast';
import { copyText } from '@/lib/copy-text';
import { cn } from '@/lib/utils';

/** The digest markers are for the parent model; the card shows the body. */
function stripUntrustedMarkers(text: string): string {
  return text
    .replace(/^UNTRUSTED_SUBAGENT_BEGIN\n?/, '')
    .replace(/\n?UNTRUSTED_SUBAGENT_END$/, '')
    .trim();
}

/** Objective from delegate args (JSON string), for the rebuilt card title. */
function delegateObjective(args: string | undefined): string {
  if (!args) return '';
  try {
    const parsed = JSON.parse(args) as { objective?: unknown };
    return typeof parsed.objective === 'string' ? parsed.objective : '';
  } catch {
    return '';
  }
}

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

/** File rows with settled edit_file results, for the summary strip. */
function changedFilesSummary(rows: ToolCallRow[]): ChangesSummaryProps | null {
  const files: ToolCallRow[] = [];
  let plus = 0;
  let minus = 0;
  let pending = false;

  for (const row of rows) {
    if (row.toolName !== 'edit_file') continue;
    if (row.status === 'running') {
      pending = true;
      continue;
    }
    if (row.status === 'failed' || row.status === 'skipped') continue;
    const summary = summarizeToolRow(row);
    files.push(row);
    plus += summary.plus ?? 0;
    minus += summary.minus ?? 0;
  }

  if (files.length === 0 && !pending) return null;
  return {
    files: files.length,
    plus,
    minus,
    pending,
  };
}

type ChangesSummaryProps = {
  files: number;
  plus: number;
  minus: number;
  pending: boolean;
};

function ChangesSummary({ files, plus, minus, pending }: ChangesSummaryProps) {
  return (
    <div
      className="flex items-center gap-2 overflow-hidden rounded-lg border border-border/50 bg-muted/30 px-3 py-2"
      aria-label={
        pending ? 'Writing files…' : `Changed ${files} files +${plus} −${minus}`
      }
    >
      <FilePenLine className="size-3.5 shrink-0 text-muted-foreground" />
      {pending ? (
        <span className="type-caption text-muted-foreground">
          Writing files…
        </span>
      ) : (
        <>
          <span className="type-caption font-medium text-muted-foreground/80">
            Changed {files} {files === 1 ? 'file' : 'files'}
          </span>
          <span className="type-caption flex-1 font-mono tabular-nums">
            <span className="text-[var(--status-ok)]">+{plus}</span>{' '}
            <span className="text-[var(--status-failed)]">−{minus}</span>
          </span>
        </>
      )}
    </div>
  );
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
 * Each tool call renders as its own inline card in the stream. No group
 * accordion: every row is independently collapsible, so the user always
 * sees what the agent is doing without expanding a wrapper first.
 * A settled-run summary strip ("Changed N files +a −b") sits above the
 * cards when the step wrote files — the glanceable number before detail.
 */
export function ToolStepList({ rows }: { rows: ToolCallRow[] }) {
  if (rows.length === 0) return null;
  const changes = changedFilesSummary(rows);
  return (
    <div className="flex flex-col gap-2">
      {changes ? <ChangesSummary {...changes} /> : null}
      {rows.map((row) => {
        // Ledger rebuild path (UC3/UC6): delegate tool results carry a
        // machine-readable header. Parse it and render a SubagentCard
        // instead of a plain tool result.
        if (row.toolName === 'delegate' && row.result) {
          const header = parseSubagentHeader(row.result);
          if (header) {
            const activity: SubagentActivity = {
              subRunId: header.subRunId,
              subThreadId: header.subThreadId,
              profile: header.profile,
              task: delegateObjective(row.args).slice(0, 160),
              status: header.status,
              iterations: header.iterations,
              toolCalls: header.toolCalls,
              summary: stripUntrustedMarkers(subagentDigestBody(row.result)) || undefined,
              seq: 0,
            };
            return (
              <SubagentCard
                key={`subagent-${header.subRunId}`}
                activity={activity}
              />
            );
          }
        }
        return <ToolCard key={row.toolCallId} row={row} />;
      })}
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
      className="min-w-0 max-w-full overflow-hidden rounded-lg border border-border/50 bg-muted/30"
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
          <span className="type-caption shrink-0 font-mono tabular-nums text-[var(--status-failed)]">
            −{summary.minus}
          </span>
        ) : null}
        {summary.plus !== undefined ? (
          <span className="type-caption shrink-0 font-mono tabular-nums text-[var(--status-ok)]">
            +{summary.plus}
          </span>
        ) : null}
        {row.durationMs !== undefined && row.status !== 'running' ? (
          <span className="type-caption shrink-0 tabular-nums text-muted-foreground/70">
            {row.durationMs}ms
          </span>
        ) : null}
        <StatusIcon status={row.status} />
        <ChevronDown
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open ? (
        <div className="min-w-0 max-h-[60vh] overflow-y-auto overflow-x-auto border-t border-border/40 bg-background/40">
          <ToolPreview row={row} summary={summary} />
        </div>
      ) : (
        <div className="relative min-w-0 max-h-24 overflow-hidden border-t border-border/40 bg-background/40">
          <ToolPreview row={teaserRow(row)} summary={summary} />
          {/* Fade-to-edge so the clipped teaser reads as "more below — expand". */}
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-6 bg-gradient-to-t from-background/90 to-transparent" />
        </div>
      )}

      {/* No bottom bar: the header is the one expand affordance, matching the
          competitive norm (Cursor/ChatGPT tool cards) of one control per card. */}
    </article>
  );
}

/** Per-type preview body. Picks a renderer by tool name; falls back to a
 *  generic args + result view. All renderers share the 60vh scroll cap. */

// Collapsed cards mount the preview too; cap result text so a large ledger
// tool row does not build tens of thousands of hidden DOM nodes by default.
const TEASER_MAX_CHARS = 2000;
function teaserRow(row: ToolCallRow): ToolCallRow {
  if (!row.result || row.result.length <= TEASER_MAX_CHARS) return row;
  return { ...row, result: row.result.slice(0, TEASER_MAX_CHARS) };
}

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
    const ok = await copyText(text);
    if (!ok) {
      toastError(
        "Couldn't copy — your browser blocked clipboard access",
        'Copy failed',
      );
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="type-caption h-5 gap-1 px-1.5 text-muted-foreground"
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
      <p className="type-caption px-3 py-2 italic text-muted-foreground/70">
        {row.status === 'running' ? 'Reading…' : 'No output captured.'}
      </p>
    );
  }
  // read_file results open with "[lines a–b of N]"; number the gutter from a.
  // Older ledger rows have no header and start at line 1.
  const header = content.match(/^\[lines? (\d+)(?:–\d+)? of ([^\]\n]*)\]\n/);
  const firstLine = header ? Number(header[1]) : 1;
  let body = header ? content.slice(header[0].length) : content;
  // "(read_file truncated … continue with offset=…)" is a note, not a file line.
  const note = body.match(/\n\n(\((?:read_file truncated|continue with)[^\n]*\))$/);
  if (note) body = body.slice(0, note.index);
  const lines = body.split('\n');
  const label = header
    ? `File · lines ${firstLine}–${firstLine + lines.length - 1} of ${header[2]}`
    : `File · ${lines.length} lines`;
  return (
    <div className="min-w-0">
      <PreviewHeader
        label={label}
        onCopy={<CopyButton text={content} />}
      />
      <pre
        className={cn(
          PREVIEW_SCROLL,
          'm-0 min-w-0 whitespace-pre-wrap break-words px-3 py-2 font-mono type-caption leading-relaxed text-foreground/90',
        )}
      >
        {lines.map((line, i) => (
          <span key={i} className="block">
            <span className="mr-3 inline-block w-8 shrink-0 select-none text-right text-muted-foreground/40 tabular-nums">
              {firstLine + i}
            </span>
            <span>{line}</span>
          </span>
        ))}
      </pre>
      {note ? (
        <p className="type-caption px-3 pb-2 italic text-muted-foreground/70">
          {note[1]}
        </p>
      ) : null}
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
      <p className="type-caption px-3 py-2 italic text-muted-foreground/70">
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
              'm-0 min-w-0 whitespace-pre-wrap break-words rounded-lg bg-[var(--diff-removed-bg)] px-2.5 py-2 font-mono type-caption leading-relaxed text-[var(--diff-removed-fg)] ring-1 ring-[var(--diff-removed-ring)]',
            )}
          >
            {oldLines.map((line, i) => (
              <span key={i} className="block">
                <span className="mr-2 select-none text-[var(--diff-removed-fg)]/70">−</span>
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
              'm-0 min-w-0 whitespace-pre-wrap break-words rounded-lg bg-[var(--diff-added-bg)] px-2.5 py-2 font-mono type-caption leading-relaxed text-[var(--diff-added-fg)] ring-1 ring-[var(--diff-added-ring)]',
            )}
          >
            {newLines.map((line, i) => (
              <span key={i} className="block">
                <span className="mr-2 select-none text-[var(--diff-added-fg)]/70">+</span>
                {line}
              </span>
            ))}
          </pre>
        </div>
      ) : null}
      {oldLines.length === 0 && newLines.length === 0 ? (
        <p className="type-caption italic text-muted-foreground/70">
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
          'm-0 min-w-0 whitespace-pre-wrap break-words rounded-lg bg-[var(--terminal-bg)] px-2.5 py-2 font-mono type-caption leading-relaxed text-[var(--terminal-fg)] ring-1 ring-[var(--terminal-ring)]',
        )}
      >
        <span className="block text-[var(--terminal-prompt)]">
          <span className="mr-1 select-none text-[var(--terminal-muted)]">$</span>
          {command}
        </span>
        {row.status === 'running' ? (
          <span className="mt-1 flex items-center gap-1.5 text-[var(--terminal-muted)]">
            <Loader2 className="size-3 animate-spin" />
            Running…
          </span>
        ) : output ? (
          <span className="mt-1 block text-[var(--terminal-fg)]/85">{output}</span>
        ) : (
          <span className="mt-1 block text-[var(--terminal-muted)]">No output.</span>
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
            'm-0 min-w-0 whitespace-pre-wrap break-words px-1 py-1 font-mono type-caption leading-relaxed text-foreground/90',
          )}
        >
          {result}
        </pre>
      ) : row.status === 'running' ? (
        <p className="type-caption italic text-muted-foreground/70">Searching…</p>
      ) : (
        <p className="type-caption italic text-muted-foreground/70">
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
            'm-0 min-w-0 whitespace-pre-wrap break-words px-1 py-1 font-mono type-caption leading-relaxed text-foreground/90',
          )}
        >
          {content}
        </pre>
      ) : row.status === 'running' ? (
        <p className="type-caption italic text-muted-foreground/70">Fetching…</p>
      ) : (
        <p className="type-caption italic text-muted-foreground/70">
          No content.
        </p>
      )}
    </div>
  );
}

/** plan / todo / offer_choice / default: raw args + result. These tools have
 *  dedicated settled-state cards elsewhere in the UI; this shows the raw call. */

/* ---------- structured (JSON) result table ---------- */

type JsonTable = { columns: string[]; rows: string[][] };

/**
 * Parse a tool result into rows/columns when the result is a JSON array of
 * uniformly-keyed records — the shape list-style tools emit. Returns null
 * for anything else (plain text keeps the <pre>). Caps protect the DOM from
 * pathological results; non-scalar cells render empty rather than as
 * "[object Object]".
 */
const JSON_TABLE_MAX_ROWS = 100;
const JSON_TABLE_MAX_COLUMNS = 6;
const JSON_TABLE_VALUE_MAX_CHARS = 200;

function parseJsonTable(result: string): JsonTable | null {
  const trimmed = result.trim();
  if (trimmed.charCodeAt(0) !== 91 /* [ */) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  if (!parsed.every(isPlainRecord)) return null;

  // Column order = first-seen across records; reject over-wide results so a
  // stray JSON object dump still gets the plain <pre>.
  const columns: string[] = [];
  for (const record of parsed) {
    for (const key of Object.keys(record)) {
      if (!columns.includes(key)) {
        if (columns.length === JSON_TABLE_MAX_COLUMNS) return null;
        columns.push(key);
      }
    }
  }
  const rows = parsed.slice(0, JSON_TABLE_MAX_ROWS).map((record) =>
    columns.map((column) => {
      const raw = record[column];
      if (raw === null || raw === undefined) return '';
      if (typeof raw === 'string') return shortenCell(raw);
      if (typeof raw === 'number' || typeof raw === 'boolean') {
        return String(raw);
      }
      return '';
    }),
  );
  return { columns, rows };
}

function shortenCell(text: string): string {
  return text.length > JSON_TABLE_VALUE_MAX_CHARS
    ? `${text.slice(0, JSON_TABLE_VALUE_MAX_CHARS)}…`
    : text;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value)
  );
}

function JsonTable({ table }: { table: JsonTable }) {
  return (
    <div className="min-w-0 px-1 py-1">
      <table className="w-full border-collapse font-mono text-xs">
        <thead>
          <tr className="border-b border-border/60 text-left">
            {table.columns.map((column) => (
              <th
                key={column}
                className="whitespace-nowrap px-2 py-1 font-medium text-muted-foreground/80"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((cells, i) => (
            <tr key={i} className="border-b border-border/25">
              {cells.map((cell, j) => (
                <td
                  key={j}
                  className="max-w-[28ch] truncate px-2 py-1 text-foreground/90"
                  title={cell}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.rows.length === JSON_TABLE_MAX_ROWS ? (
        <p className="type-caption mt-1 text-muted-foreground/70">
          First {JSON_TABLE_MAX_ROWS} rows shown.
        </p>
      ) : null}
    </div>
  );
}

function GenericPreview({ row }: { row: ToolCallRow }) {
  const args = row.args ?? '';
  const result = row.result ?? '';
  const table = useMemo(
    () => (result ? parseJsonTable(result) : null),
    [result],
  );

  return (
    <div className="min-w-0 space-y-2 px-3 py-2">
      {args ? (
        <div className="min-w-0">
          <PreviewHeader label="Args" onCopy={<CopyButton text={args} />} />
          <pre
            className={cn(
              PREVIEW_SCROLL,
              'm-0 min-w-0 whitespace-pre-wrap break-words px-1 py-1 font-mono type-caption leading-relaxed text-foreground/90',
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
          {table && table.rows.length > 0 ? (
            <JsonTable table={table} />
          ) : (
            <pre
              className={cn(
                PREVIEW_SCROLL,
                'm-0 min-w-0 whitespace-pre-wrap break-words px-1 py-1 font-mono type-caption leading-relaxed text-foreground/90',
              )}
            >
              {result}
            </pre>
          )}
        </div>
      ) : row.status === 'running' ? (
        <p className="type-caption italic text-muted-foreground/70">Running…</p>
      ) : (
        <p className="type-caption italic text-muted-foreground/70">
          No output captured.
        </p>
      )}
    </div>
  );
}

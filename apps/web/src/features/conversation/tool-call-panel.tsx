'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  Ban,
  Check,
  ChevronDown,
  Copy,
  Loader2,
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
    case 'todo': {
      const todos = todoItems(args);
      const done = todos.filter((t) => t.status === 'completed').length;
      return {
        kind: 'other',
        title: todos.length ? `${done} of ${todos.length} done` : 'checklist',
        action: 'Todos',
      };
    }
    case 'offer_choice':
      return {
        kind: 'other',
        title: asString(args.question) || 'choice',
        action: 'Choice',
      };
    case 'record_finding':
      return {
        kind: 'other',
        title: asString(args.claim) || 'finding',
        action: 'Finding',
      };
    default:
      return { kind: 'other', title: row.toolName, action: row.toolName };
  }
}

/**
 * The collapsed group line ("Read 2 files, edited ledger.ts +41 −3"), with
 * a failed count for the colored suffix. Verbs stay in narrative order —
 * look, search, change, run, fetch — and a single edit (or read) prints its
 * file name instead of a count.
 */
type GroupHeader = {
  text: string;
  plus: number;
  minus: number;
  failed: number;
};

function groupHeader(rows: ToolCallRow[]): GroupHeader {
  const readFiles: string[] = [];
  const editFiles: string[] = [];
  const otherActions: string[] = [];
  let searches = 0;
  let commands = 0;
  let fetches = 0;
  let plus = 0;
  let minus = 0;
  let failed = 0;

  for (const row of rows) {
    if (row.status === 'failed') failed += 1;
    const summary = summarizeToolRow(row);
    switch (row.toolName) {
      case 'read_file':
        readFiles.push(summary.title);
        break;
      case 'edit_file':
        if (row.status !== 'failed' && row.status !== 'skipped') {
          editFiles.push(summary.title);
          plus += summary.plus ?? 0;
          minus += summary.minus ?? 0;
        }
        break;
      case 'glob':
      case 'grep':
      case 'web_search':
        searches += 1;
        break;
      case 'run_terminal':
        commands += 1;
        break;
      case 'web_fetch':
        fetches += 1;
        break;
      default:
        otherActions.push(summary.action);
        break;
    }
  }

  const parts: string[] = [];
  if (readFiles.length === 1) parts.push(`Read ${readFiles[0]}`);
  else if (readFiles.length > 1) parts.push(`Read ${readFiles.length} files`);
  if (searches === 1) parts.push('Searched');
  else if (searches > 1) parts.push(`Searched ${searches} times`);
  if (editFiles.length === 1) parts.push(`Edited ${editFiles[0]}`);
  else if (editFiles.length > 1) parts.push(`Edited ${editFiles.length} files`);
  if (commands === 1) parts.push('Ran a command');
  else if (commands > 1) parts.push(`Ran ${commands} commands`);
  if (fetches === 1) parts.push('Fetched a page');
  else if (fetches > 1) parts.push(`Fetched ${fetches} pages`);
  if (otherActions.length === 1) {
    const verb = otherActions[0];
    parts.push(verb.charAt(0).toUpperCase() + verb.slice(1));
  } else if (otherActions.length > 1) {
    parts.push(`${otherActions.length} tool calls`);
  }

  return {
    text: parts.join(', ') || 'Tool calls',
    plus,
    minus,
    failed,
  };
}

function StatusIcon({ status }: { status: ToolCallRow['status'] }) {
  if (status === 'running') {
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />;
  }
  if (status === 'failed') {
    return <X className="size-3.5 shrink-0 text-destructive" />;
  }
  if (status === 'skipped') {
    return <Ban className="size-3.5 shrink-0 text-subtle-foreground" />;
  }
  // Settled, successful rows stay bare — the lean line is the point.
  return null;
}

/**
 * One contiguous tool batch, lean: a single muted header line ("Read 2
 * files, edited ledger.ts +41 −3 ›") collapses the whole batch; clicking it
 * opens flat one-line rows, each of which expands to its per-type preview on
 * a second click. Assistant prose between batches stays full-width — prose
 * owns the reading path, tool detail is one deliberate click away.
 *
 * While any row is still running the group renders open with a pulse sweep
 * on the running row; it collapses to the header once everything settles.
 */
export const ToolStepList = memo(function ToolStepList({ rows }: { rows: ToolCallRow[] }) {
  const hasSubagentRows = rows.some(
    (row) => row.toolName === 'delegate' && parseSubagentHeader(row.result ?? ''),
  );

  if (rows.length === 0) return null;
  if (
    hasSubagentRows &&
    rows.every(
      (row) => row.toolName === 'delegate' && parseSubagentHeader(row.result ?? ''),
    )
  ) {
    return (
      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <SubagentRow key={row.toolCallId} row={row} />
        ))}
      </div>
    );
  }
  return <ToolGroup rows={rows} />;
});

/** Ledger rebuild path (UC3/UC6): a delegate result carries a
 * machine-readable header; the row renders as the full SubagentCard. */
function SubagentRow({ row }: { row: ToolCallRow }) {
  const header = parseSubagentHeader(row.result ?? '');
  if (!header) return null;
  const activity: SubagentActivity = {
    subRunId: header.subRunId,
    subThreadId: header.subThreadId,
    profile: header.profile,
    task: delegateObjective(row.args).slice(0, 160),
    status: header.status,
    iterations: header.iterations,
    toolCalls: header.toolCalls,
    summary: stripUntrustedMarkers(subagentDigestBody(row.result ?? '')) || undefined,
    seq: 0,
  };
  return <SubagentCard activity={activity} />;
}

function ToolGroup({ rows }: { rows: ToolCallRow[] }) {
  const runningRow = rows.find((row) => row.status === 'running');
  const isRunning = runningRow !== undefined;
  const [open, setOpen] = useState(isRunning);
  const wasRunning = useRef(isRunning);
  const gh = useMemo(() => groupHeader(rows), [rows]);

  // A live batch mounts open and auto-collapses on the running→settled edge,
  // when the ledger results have landed and the header line is final. A
  // settled batch from the ledger starts collapsed.
  useEffect(() => {
    if (isRunning) {
      wasRunning.current = true;
      return;
    }
    if (wasRunning.current) {
      wasRunning.current = false;
      setOpen(false);
    }
  }, [isRunning]);

  const toggle = () => setOpen((prev) => !prev);

  return (
    <div className="w-full min-w-0">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/30"
      >
        {runningRow ? <StatusIcon status={runningRow.status} /> : null}
        {open ? (
          <span className="type-caption shrink-0 font-medium text-muted-foreground">
            Details
          </span>
        ) : (
          <span
            className={cn(
              'min-w-0 flex-1 truncate type-caption font-medium text-muted-foreground',
              runningRow && 'tool-running',
            )}
          >
            {gh.text}
          </span>
        )}
        {!open && gh.plus > 0 ? (
          <span className="type-caption shrink-0 font-mono tabular-nums text-[var(--status-ok)]">
            +{gh.plus}
          </span>
        ) : null}
        {!open && gh.minus > 0 ? (
          <span className="type-caption shrink-0 font-mono tabular-nums text-[var(--status-failed)]">
            −{gh.minus}
          </span>
        ) : null}
        {!open && gh.failed > 0 ? (
          <span className="type-caption shrink-0 font-mono tabular-nums text-destructive">
            {gh.failed} failed
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open ? (
        <div className="mt-1 min-w-0 space-y-0.5 rounded-lg border border-border/40 bg-muted/20 px-2 py-1.5">
          {rows.map((row) =>
            row.toolName === 'delegate' &&
            parseSubagentHeader(row.result ?? '') ? (
              <SubagentRow key={row.toolCallId} row={row} />
            ) : (
              <ToolRow key={row.toolCallId} row={row} />
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}

/** One line inside an open group. Click toggles the inline per-type preview. */
function ToolRow({ row }: { row: ToolCallRow }) {
  const summary = useMemo(() => summarizeToolRow(row), [row]);
  const [open, setOpen] = useState(false);

  const toggle = () => setOpen((prev) => !prev);
  const line = summary.action + ': ' + summary.title;

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-accent/30"
      >
        <StatusIcon status={row.status} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate type-caption font-mono text-foreground',
            row.status === 'running' && 'tool-running',
          )}
       >
          {line}
          {!open ? ' ›' : ''}
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
          <span className="type-caption shrink-0 tabular-nums text-subtle-foreground">
            {row.durationMs}ms
          </span>
        ) : null}
        <ChevronDown
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open ? (
        <div className="min-w-0 max-h-[60vh] overflow-y-auto overflow-x-auto rounded-lg border border-border/40 bg-card">
          <ToolPreview row={teaserRow(row)} summary={summary} />
        </div>
      ) : null}
    </div>
  );
}

/** Per-type preview body. Picks a renderer by tool name; falls back to a
 *  generic args + result view. All renderers share the 60vh scroll cap. */

// Previews mount only while their row is open; cap result text so one
// expanded preview can't build a huge DOM when the ledger row is very large.
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
    case 'todo':
      return <TodoPreview row={row} />;
    default:
      return <GenericPreview row={row} />;
  }
}

/* ---------- per-type preview renderers ---------- */

const PREVIEW_SCROLL = 'overflow-x-auto';

function CopyButton({
  text,
  label = 'Copy',
}: {
  text: string;
  label?: string;
}) {
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
      <p className="type-caption font-medium text-subtle-foreground">{label}</p>
      {onCopy}
    </div>
  );
}

/** read_file: full file content with a line-number gutter. */
function FileReadPreview({ row }: { row: ToolCallRow }) {
  const content = row.result ?? '';
  if (!content) {
    return (
      <p className="type-caption px-3 py-2 italic text-subtle-foreground">
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
  const note = body.match(
    /\n\n(\((?:read_file truncated|continue with)[^\n]*\))$/,
  );
  if (note) body = body.slice(0, note.index);
  const rawLines = body.split('\n');
  // Newer results number each line "N<TAB>text"; older ones are plain. The
  // number feeds the gutter and is stripped from the text and from copy.
  const numbered =
    rawLines.length > 0 &&
    /^\s*\d+\t/.test(rawLines[0] ?? '') &&
    rawLines.every((line) => line === '' || /^\s*\d+\t/.test(line));
  const lines = numbered
    ? rawLines.map((line) => {
        const match = /^\s*(\d+)\t/.exec(line);
        return match
          ? { n: Number(match[1]), text: line.slice(match[0].length) }
          : { n: undefined, text: line };
      })
    : rawLines.map((line, i) => ({ n: firstLine + i, text: line }));
  const lastLine =
    [...lines].reverse().find((line) => line.n !== undefined)?.n ??
    firstLine + lines.length - 1;
  const label = header
    ? `File · lines ${firstLine}–${lastLine} of ${header[2]}`
    : `File · ${lines.length} lines`;
  const copyText = numbered ? lines.map((line) => line.text).join('\n') : content;
  return (
    <div className="min-w-0">
      <PreviewHeader label={label} onCopy={<CopyButton text={copyText} />} />
      <pre
        className={cn(
          PREVIEW_SCROLL,
          'm-0 min-w-0 whitespace-pre-wrap break-words px-3 py-2 font-mono type-caption leading-relaxed text-foreground/90',
        )}
      >
        {lines.map((line, i) => (
          <span key={i} className="block">
            <span className="mr-3 inline-block w-8 shrink-0 select-none text-right text-muted-foreground/40 tabular-nums">
              {line.n ?? ''}
            </span>
            <span>{line.text}</span>
          </span>
        ))}
      </pre>
      {note ? (
        <p className="type-caption px-3 pb-2 italic text-subtle-foreground">
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
      <p className="type-caption px-3 py-2 italic text-subtle-foreground">
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
                <span className="mr-2 select-none text-[var(--diff-removed-fg)]/70">
                  −
                </span>
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
                <span className="mr-2 select-none text-[var(--diff-added-fg)]/70">
                  +
                </span>
                {line}
              </span>
            ))}
          </pre>
        </div>
      ) : null}
      {oldLines.length === 0 && newLines.length === 0 ? (
        <p className="type-caption italic text-subtle-foreground">
          {row.result || 'No diff available.'}
        </p>
      ) : null}
    </div>
  );
}

/** run_terminal: the output as one flat terminal well. The command lives in
 *  the card header (it wraps there when the card is open), so it is never
 *  repeated here. */
function TerminalPreview({ row }: { row: ToolCallRow }) {
  const output = row.status === 'running' ? '' : (row.result ?? '');

  return (
    <div className="relative min-w-0 bg-[var(--terminal-bg)]">
      {output ? (
        <div className="absolute top-1 right-1.5 z-10">
          <CopyButton text={output} />
        </div>
      ) : null}
      <pre
        className={cn(
          PREVIEW_SCROLL,
          'm-0 min-w-0 whitespace-pre-wrap break-words px-3 py-2 pr-16 font-mono type-caption leading-relaxed text-[var(--terminal-fg)]',
        )}
      >
        {row.status === 'running' ? (
          <span className="flex items-center gap-1.5 text-[var(--terminal-muted)]">
            <Loader2 className="size-3 animate-spin" />
            Running…
          </span>
        ) : output ? (
          output
        ) : (
          <span className="text-[var(--terminal-muted)]">No output.</span>
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
        <p className="type-caption italic text-subtle-foreground">Searching…</p>
      ) : (
        <p className="type-caption italic text-subtle-foreground">
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
        <p className="type-caption italic text-subtle-foreground">Fetching…</p>
      ) : (
        <p className="type-caption italic text-subtle-foreground">
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
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
                className="whitespace-nowrap px-2 py-1 font-medium text-muted-foreground"
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
        <p className="type-caption mt-1 text-subtle-foreground">
          First {JSON_TABLE_MAX_ROWS} rows shown.
        </p>
      ) : null}
    </div>
  );
}

type TodoItem = { content: string; status: string };

/** todo args → items; tolerant of partial/streaming args. */
function todoItems(args: Record<string, unknown>): TodoItem[] {
  if (!Array.isArray(args.todos)) return [];
  return args.todos.flatMap((t) => {
    if (!t || typeof t !== 'object') return [];
    const item = t as Record<string, unknown>;
    const content = asString(item.content);
    return content
      ? [{ content, status: asString(item.status) || 'pending' }]
      : [];
  });
}

const TODO_MARK: Record<string, string> = {
  completed: '✓',
  in_progress: '◐',
  pending: '○',
};

/** todo: the checklist itself, not its JSON. */
function TodoPreview({ row }: { row: ToolCallRow }) {
  const todos = todoItems(parseArgs(row.args));
  if (todos.length === 0) return <GenericPreview row={row} />;
  return (
    <ul className="min-w-0 space-y-1 px-3 py-2 type-ui">
      {todos.map((todo, i) => (
        <li key={i} className="flex min-w-0 items-start gap-2">
          <span
            aria-hidden
            className={cn(
              'w-3.5 shrink-0 text-center tabular-nums',
              todo.status === 'completed'
                ? 'text-[var(--status-ok)]'
                : 'text-subtle-foreground',
            )}
          >
            {TODO_MARK[todo.status] ?? '○'}
          </span>
          <span
            className={cn(
              'min-w-0',
              todo.status === 'completed'
                ? 'text-muted-foreground line-through decoration-subtle-foreground/60'
                : 'text-foreground',
            )}
          >
            <span className="sr-only">{todo.status.replace('_', ' ')}: </span>
            {todo.content}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Top-level args as label/value pairs; nested values are summarised. */
function readableArgs(raw: string): Array<[string, string]> | null {
  const args = parseArgs(raw);
  const entries = Object.entries(args);
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => {
    if (Array.isArray(value)) return [key, `${value.length} items`];
    if (value && typeof value === 'object') return [key, '{…}'];
    return [key, String(value)];
  });
}

function GenericPreview({ row }: { row: ToolCallRow }) {
  const args = row.args ?? '';
  const pairs = useMemo(() => readableArgs(args), [args]);
  const result = row.result ?? '';
  const table = useMemo(
    () => (result ? parseJsonTable(result) : null),
    [result],
  );

  return (
    <div className="min-w-0 space-y-2 px-3 py-2">
      {args ? (
        <div className="min-w-0">
          <PreviewHeader label="Input" onCopy={<CopyButton text={args} />} />
          {pairs ? (
            <dl className="grid min-w-0 grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 px-1 py-1 type-caption">
              {pairs.map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-subtle-foreground">{key}</dt>
                  <dd
                    className="m-0 min-w-0 truncate text-foreground"
                    title={value}
                  >
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          ) : null}
          {/* Raw JSON stays one click away for debugging, out of the
              reading path. */}
          <details className="px-1">
            <summary className="type-caption cursor-pointer text-subtle-foreground hover:text-foreground">
              Raw JSON
            </summary>
            <pre
              className={cn(
                PREVIEW_SCROLL,
                'm-0 mt-1 min-w-0 whitespace-pre-wrap break-words font-mono type-caption leading-relaxed text-foreground/90',
              )}
            >
              {args}
            </pre>
          </details>
        </div>
      ) : null}
      {result ? (
        <div className="min-w-0">
          <PreviewHeader label="Output" onCopy={<CopyButton text={result} />} />
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
        <p className="type-caption italic text-subtle-foreground">Running…</p>
      ) : (
        <p className="type-caption italic text-subtle-foreground">
          No output captured.
        </p>
      )}
    </div>
  );
}

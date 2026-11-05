import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  limitCodeOf,
  parseThreadLastRun,
  RUN_CANCELLED_REASON,
  RUN_INTERRUPTED_REASON,
  type RunUsage,
  type ThreadLastRun,
} from '@agent/agent-models';

import { readCatalog } from './catalog.js';
import { linesOf, readRunTrace, type TraceLine } from './trace.js';

/**
 * One run, summarised from its trace (+ `last-run.json` for runs whose trace
 * has no `run_finish`). The single join point: metrics, the viewer and the
 * runner consume RunSummary; trace lines load on demand from `tracePath`.
 */
export type RunSummary = {
  runId: string;
  threadId: string;
  tracePath: string;
  model?: string;
  mode?: string;
  posture?: string;
  /** 0 for a user run, 1 for a sub-agent. */
  depth: number;
  parentRunId?: string;
  /**
   * `run_finish.status`, except:
   * - `cancelled`: the thread's last-run says the user (or the eval runner) cancelled it.
   * - `interrupted`: no `run_finish` and the last-run still holds the marker written
   *   at run start: the server stopped mid-run, or the run is still going. An offline
   *   reader cannot tell those apart; the API's ledger `activeRun` can.
   * - `unknown`: no `run_finish` and no last-run for this run (older run on the thread, old trace).
   * last-run.json only describes a thread's latest run, so older cancelled runs read as their `run_finish.status`.
   */
  status: 'completed' | 'incomplete' | 'cancelled' | 'interrupted' | 'error' | 'unknown';
  limitReason?: string;
  iterations: number;
  toolCalls: number;
  /** Own + sub-agent spend from `run_finish`; absent on runs without one. */
  usage?: RunUsage;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  /** Corrupt trace lines skipped while reading. */
  traceWarnings: number;
  /** Sub-agent runs started by this run (from their `run_start.parentRunId`). */
  children: RunSummary[];
};

const FINISH_STATUSES = new Set(['completed', 'incomplete', 'error']);

function finishStatus(value: unknown): RunSummary['status'] {
  return typeof value === 'string' && FINISH_STATUSES.has(value)
    ? (value as RunSummary['status'])
    : 'unknown';
}

function statusOf(finishLine: { status?: string } | undefined, lastRun: ThreadLastRun | null): RunSummary['status'] {
  if (lastRun?.limitReason === RUN_CANCELLED_REASON) return 'cancelled';
  if (finishLine) return finishStatus(finishLine.status);
  if (lastRun?.limitReason === RUN_INTERRUPTED_REASON) return 'interrupted';
  return lastRun ? lastRun.status : 'unknown';
}

/**
 * Short label for a stop reason: its `limit.*` code, `cancelled`,
 * `interrupted`, or `other`. The one place readers turn reasons into labels.
 */
export function stopLabel(reason: string | undefined): string {
  if (!reason) return '';
  if (reason === RUN_CANCELLED_REASON) return 'cancelled';
  if (reason === RUN_INTERRUPTED_REASON) return 'interrupted';
  return limitCodeOf(reason) ?? 'other';
}

/** Pure: a RunSummary from parsed trace lines. Exported for fixtures and the viewer. */
export function summarizeRun(input: {
  runId: string;
  threadId: string;
  tracePath: string;
  lines: TraceLine[];
  warnings: number;
  lastRun?: ThreadLastRun | null;
}): RunSummary {
  const { lines } = input;
  const start = linesOf(lines, 'run_start')[0];
  const finish = linesOf(lines, 'run_finish').at(-1);
  const limit = linesOf(lines, 'limit').at(-1);
  // Only trust last-run.json when it describes this run.
  const lastRun = input.lastRun?.runId === input.runId ? input.lastRun : null;

  const startedAt = start?.ts ?? lines[0]?.ts;
  const status = statusOf(finish, lastRun);
  // A cancel or crash is the reason the run stopped, whatever the loop wrote last.
  const finishedAt = finish?.ts ?? (status === 'interrupted' ? undefined : lastRun?.finishedAt);
  const limitReason =
    status === 'cancelled' || status === 'interrupted'
      ? lastRun?.limitReason
      : (finish?.limitReason ?? limit?.reason ?? lastRun?.limitReason);
  const durationMs =
    finish?.durationMs ??
    (startedAt && finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : undefined);

  return {
    runId: input.runId,
    threadId: input.threadId,
    tracePath: input.tracePath,
    ...(start?.model ? { model: start.model } : {}),
    ...(start?.mode ? { mode: start.mode } : {}),
    ...(start?.posture ? { posture: start.posture } : {}),
    depth: start?.depth ?? 0,
    ...(start?.parentRunId ? { parentRunId: start.parentRunId } : {}),
    status,
    ...(limitReason ? { limitReason } : {}),
    iterations: finish?.iterations ?? linesOf(lines, 'llm_response').length,
    toolCalls: finish?.toolCalls ?? linesOf(lines, 'tool_start').length,
    ...(finish?.usage ? { usage: finish.usage } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(finishedAt ? { finishedAt } : {}),
    ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}),
    traceWarnings: input.warnings,
    children: [],
  };
}

async function readLastRun(threadDir: string): Promise<ThreadLastRun | null> {
  try {
    return parseThreadLastRun(JSON.parse(await readFile(path.join(threadDir, 'last-run.json'), 'utf8')));
  } catch {
    return null;
  }
}

async function threadRuns(home: string, threadId: string): Promise<RunSummary[]> {
  const threadDir = path.join(home, 'sessions', threadId);
  const tracesDir = path.join(threadDir, 'traces');
  let files: string[];
  try {
    files = (await readdir(tracesDir)).filter((file) => file.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const lastRun = await readLastRun(threadDir);
  const runs: RunSummary[] = [];
  for (const file of files) {
    const tracePath = path.join(tracesDir, file);
    const parsed = await readRunTrace(tracePath);
    runs.push(
      summarizeRun({
        runId: file.slice(0, -'.jsonl'.length),
        threadId,
        tracePath,
        lines: parsed.lines,
        warnings: parsed.warnings,
        lastRun,
      }),
    );
  }
  return runs;
}

/** Threads to read: one thread plus its sub-agent threads, or every thread. */
async function threadIds(home: string, threadId?: string): Promise<string[]> {
  if (!threadId) {
    try {
      return await readdir(path.join(home, 'sessions'));
    } catch {
      return [];
    }
  }
  // Sub-agent runs live in their own threads; the catalog links them.
  const children = existsSync(path.join(home, 'catalog.db'))
    ? readCatalog(home)
        .filter((thread) => thread.parentThreadId === threadId)
        .map((thread) => thread.id)
    : [];
  return [threadId, ...children];
}

/**
 * One run by id, reading only its own thread (and that thread's sub-agent
 * threads): the thread is found from the directory listing, not by parsing
 * every trace in the home. Null when no thread has `<runId>.jsonl`.
 */
export async function readRun(home: string, runId: string): Promise<RunSummary | null> {
  let threads: string[];
  try {
    threads = await readdir(path.join(home, 'sessions'));
  } catch {
    return null;
  }
  const threadId = threads.find((id) => existsSync(path.join(home, 'sessions', id, 'traces', `${runId}.jsonl`)));
  if (!threadId) return null;
  const find = (runs: RunSummary[]): RunSummary | null => {
    for (const run of runs) {
      if (run.runId === runId) return run;
      const child = find(run.children);
      if (child) return child;
    }
    return null;
  };
  return find(await listRuns(home, { threadId }));
}

/**
 * Runs under an agent home, newest first, with sub-agent runs nested under
 * the run that started them. `threadId` limits to one thread (and its
 * sub-agent threads); `since` (ISO) keeps runs started at or after it.
 */
export async function listRuns(
  home: string,
  opts: { threadId?: string; since?: string } = {},
): Promise<RunSummary[]> {
  const all: RunSummary[] = [];
  for (const id of await threadIds(home, opts.threadId)) {
    all.push(...(await threadRuns(home, id)));
  }
  const byId = new Map(all.map((run) => [run.runId, run]));
  const roots: RunSummary[] = [];
  for (const run of all) {
    const parent = run.parentRunId ? byId.get(run.parentRunId) : undefined;
    if (parent) parent.children.push(run);
    else roots.push(run);
  }
  const newestFirst = (a: RunSummary, b: RunSummary) =>
    (b.startedAt ?? '').localeCompare(a.startedAt ?? '');
  for (const run of all) run.children.sort(newestFirst);
  return roots
    .filter((run) => !opts.since || (run.startedAt ?? '') >= opts.since)
    .sort(newestFirst);
}

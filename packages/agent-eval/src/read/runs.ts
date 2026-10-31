import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { TraceEvent } from '@agent/agent-models';
import { readRunTrace } from './trace.js';

/**
 * Summary of one run, built from the trace file + last-run.json. This is the
 * join point: every downstream consumer (E1 metrics, E4 timeline, E6 analyst)
 * reads RunSummary, not raw traces. No second reader anywhere.
 */
export type RunSummary = {
  runId: string;
  threadId: string;
  model: string;
  mode: string;
  posture: string;
  depth: number;
  status: string;
  limitReason?: string;
  iterations: number;
  toolCalls: number;
  promptTokensOwn: number;
  promptTokensChildren: number;
  durationMs: number;
  startedAt: string;
  finishedAt?: string;
  tracePath: string;
  events: (TraceEvent | { type: 'unknown'; raw: unknown })[];
  traceWarnings: number;
  childRuns: RunSummary[];
};

type LastRunJson = {
  runId: string;
  status: string;
  model?: string;
  mode?: string;
  posture?: string;
  limitReason?: string;
  startedAt?: string;
  finishedAt?: string;
  iterations?: number;
  depth?: number;
};

/**
 * List runs for a home, optionally filtered to a thread. Walks
 * `sessions/<threadId>/traces/*.jsonl` and reads `last-run.json` for status.
 * Child runs (parent_run_id set in catalog) are nested under their parent.
 */
export async function listRuns(
  home: string,
  opts: { threadId?: string; since?: string } = {},
): Promise<RunSummary[]> {
  const sessionsDir = path.join(home, 'sessions');
  let threadDirs: string[];
  try {
    threadDirs = await readdir(sessionsDir);
  } catch {
    return [];
  }

  const runs: RunSummary[] = [];
  for (const threadId of threadDirs) {
    if (opts.threadId && threadId !== opts.threadId) continue;

    const threadDir = path.join(sessionsDir, threadId);
    const statResult = await stat(threadDir).catch(() => null);
    if (!statResult || !statResult.isDirectory()) continue;

    // last-run.json gives us the most recent run's status.
    const lastRunPath = path.join(threadDir, 'last-run.json');
    let lastRun: LastRunJson | null = null;
    try {
      lastRun = JSON.parse(await readFile(lastRunPath, 'utf8')) as LastRunJson;
    } catch {
      lastRun = null;
    }

    // Collect all trace files in the thread's traces/ dir.
    const tracesDir = path.join(threadDir, 'traces');
    let traceFiles: string[];
    try {
      traceFiles = await readdir(tracesDir);
    } catch {
      traceFiles = [];
    }

    for (const traceFile of traceFiles) {
      if (!traceFile.endsWith('.jsonl')) continue;
      const runId = traceFile.replace(/\.jsonl$/, '');
      const tracePath = path.join(tracesDir, traceFile);

      const parsed = await readRunTrace(tracePath);
      const summary = summarizeFromTrace(
        runId,
        threadId,
        tracePath,
        parsed.events,
        parsed.warnings,
        lastRun,
      );
      runs.push(summary);
    }
  }

  // Nest child runs under parents by matching runId to parentRunId.
  // We don't have parentRunId on RunSummary directly; the catalog reader
  // provides that link. For now, flat list — nesting is done by the caller
  // using ThreadRecord.parentRunId from readCatalog.
  return runs;
}

function summarizeFromTrace(
  runId: string,
  threadId: string,
  tracePath: string,
  events: (TraceEvent | { type: 'unknown'; raw: unknown })[],
  warnings: number,
  lastRun: LastRunJson | null,
): RunSummary {
  let iterations = 0;
  let toolCalls = 0;
  let promptTokensOwn = 0;
  let promptTokensChildren = 0;
  let model = lastRun?.model ?? 'unknown';
  let mode = lastRun?.mode ?? 'workspace';
  let posture = lastRun?.posture ?? 'default';
  let depth = lastRun?.depth ?? 0;
  let startedAt = lastRun?.startedAt ?? '';
  let finishedAt = lastRun?.finishedAt;
  let limitReason = lastRun?.limitReason;

  for (const event of events) {
    if (event.type === 'llm_request') {
      iterations++;
      const e = event as Extract<TraceEvent, { type: 'llm_request' }>;
      if (typeof e.estimatedPromptTokens === 'number') {
        promptTokensOwn += e.estimatedPromptTokens;
      }
    } else if (event.type === 'run_start') {
      const e = event as Extract<TraceEvent, { type: 'run_start' }>;
      model = e.model ?? model;
      mode = e.mode ?? mode;
      posture = e.posture ?? posture;
      depth = e.depth ?? depth;
    } else if (event.type === 'run_finish') {
      const e = event as Extract<TraceEvent, { type: 'run_finish' }>;
      finishedAt = e.ts ?? finishedAt;
      limitReason = e.limitReason ?? limitReason;
      if (typeof e.toolCalls === 'number') toolCalls = e.toolCalls;
      if (typeof e.iterations === 'number') iterations = e.iterations;
    } else if (event.type === 'tool_start') {
      toolCalls++;
    }
  }

  // run_finish has explicit iterations/toolCalls; if we only saw llm_request
  // and tool_start, use those counts.
  const durationMs = finishedAt && startedAt
    ? new Date(finishedAt).getTime() - new Date(startedAt).getTime()
    : 0;

  return {
    runId,
    threadId,
    model,
    mode,
    posture,
    depth,
    status: lastRun?.status ?? 'unknown',
    ...(limitReason ? { limitReason } : {}),
    iterations,
    toolCalls,
    promptTokensOwn,
    promptTokensChildren,
    durationMs,
    startedAt,
    ...(finishedAt ? { finishedAt } : {}),
    tracePath,
    events,
    traceWarnings: warnings,
    childRuns: [],
  };
}
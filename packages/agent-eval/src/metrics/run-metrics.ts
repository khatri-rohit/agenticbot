import type { LedgerEnvelope } from '@agent/agent-models';

import type { RunSummary } from '../read/runs.js';
import { linesOf, type TraceLine } from '../read/trace.js';
import type { UsageRecord } from '../read/usage.js';

/** Mirrors the loop's toolStage() for built-ins (packages/agent-core/src/lib/loop/loop.ts). */
export function toolStage(name: string): string {
  if (name === 'load_skill') return 'skill';
  if (['glob', 'grep', 'read_file', 'recall', 'diff'].includes(name)) return 'read';
  if (name === 'web_search' || name === 'web_fetch') return 'network';
  if (name === 'delegate') return 'subagent';
  if (name === 'run_terminal') return 'exec';
  return 'mutate';
}

/** A read walk needs at least this many narrow reads of one file in a row. */
export const READ_WALK_MIN_CALLS = 5;
/** A read with a smaller `limit` (lines) counts as narrow. */
export const READ_WALK_MAX_LIMIT = 40;

export type ReadWalk = { path: string; calls: number; fromIteration: number; toIteration: number };

export type RunMetrics = {
  runId: string;
  threadId: string;
  model?: string;
  status: RunSummary['status'];
  limitReason?: string;
  iterations: number;
  toolCalls: number;
  /** Provider-reported prompt tokens per model call (own calls only). */
  promptPerCall: { calls: number; median: number; p90: number; max: number } | null;
  promptTokens: { own: number; children: number; total: number };
  completionTokens: { own: number; children: number; total: number };
  /** Prompt ÷ completion over the whole run. */
  promptToCompletion: number | null;
  /** Sub-agent share of prompt tokens. */
  childShare: number | null;
  toolsByName: Record<string, number>;
  toolsByStage: Record<string, number>;
  networkCalls: number;
  wallClockMs?: number;
  /** From the ledger's final answer: the whole run, and the last call that wrote it. */
  runDurationMs?: number;
  answerWriteMs?: number;
  edits: number;
  firstEdit: { iteration: number; promptTokensBefore: number } | null;
  /** Prompt tokens spent up to the first edit ÷ own prompt tokens (1 when nothing was edited). */
  idleShare: number | null;
  readWalks: ReadWalk[];
  recallCalls: number;
  /** recall calls + re-reads of evicted paths; null when evictions lack ids (pre-P2 traces). */
  reReadsAfterEviction: number | null;
  steering: {
    stallNudges: number;
    researchGates: number;
    toolNotes: number;
    budgetWarnings: number;
    evictions: number;
    inRunCompactions: number;
    limits: string[];
  };
  reasoningEffort: Record<string, number>;
  /** Balance change across the run, from usage.jsonl (legacy session/weekly plans). */
  capacity: { weeklyPercent: number | null; sessionPercent: number | null } | null;
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

function count(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function argPath(args: unknown): string | undefined {
  const value = (args as { path?: unknown } | null)?.path;
  return typeof value === 'string' ? value.replace(/\\/g, '/').replace(/^\.\//, '') : undefined;
}

function argLimit(args: unknown): number | undefined {
  const value = (args as { limit?: unknown } | null)?.limit;
  return typeof value === 'number' ? value : undefined;
}

/** Same rule as the loop's isEditSuccess. */
function isEditSuccess(preview: string): boolean {
  return preview.startsWith('Created') || preview.startsWith('Patched');
}

function readWalks(lines: TraceLine[]): ReadWalk[] {
  const walks: ReadWalk[] = [];
  let current: ReadWalk | null = null;
  const close = () => {
    if (current && current.calls >= READ_WALK_MIN_CALLS) walks.push(current);
    current = null;
  };
  for (const start of linesOf(lines, 'tool_start')) {
    const path = argPath(start.args);
    const limit = argLimit(start.args);
    const narrow =
      start.toolName === 'read_file' && path !== undefined && limit !== undefined && limit < READ_WALK_MAX_LIMIT;
    if (!narrow) {
      close();
      continue;
    }
    if (current && current.path === path) {
      current.calls += 1;
      current.toIteration = start.iteration;
    } else {
      close();
      current = { path: path!, calls: 1, fromIteration: start.iteration, toIteration: start.iteration };
    }
  }
  close();
  return walks;
}

/** recall calls plus read_file of a path whose earlier result was evicted or folded. */
function reReads(lines: TraceLine[]): { recall: number; total: number | null } {
  const recall = linesOf(lines, 'tool_start').filter((line) => line.toolName === 'recall').length;
  const removals = lines.filter(
    (line) => line.type === 'context_evicted' || line.type === 'context_compacted_inrun',
  ) as Extract<TraceLine, { type: 'context_evicted' | 'context_compacted_inrun' }>[];
  if (removals.some((line) => !line.toolCallIds)) return { recall, total: null };

  const pathByCall = new Map<string, string>();
  const evicted = new Set<string>();
  let reread = 0;
  for (const line of lines) {
    if (line.type === 'tool_start' && line.toolName === 'read_file') {
      const path = argPath(line.args);
      if (!path) continue;
      if (evicted.has(path)) {
        reread += 1;
        evicted.delete(path);
      }
      if (line.toolCallId) pathByCall.set(line.toolCallId, path);
    } else if (line.type === 'context_evicted' || line.type === 'context_compacted_inrun') {
      for (const id of line.toolCallIds ?? []) {
        const path = pathByCall.get(id);
        if (path) evicted.add(path);
      }
    }
  }
  return { recall, total: recall + reread };
}

function usageDelta(record: UsageRecord | undefined): RunMetrics['capacity'] {
  const before = record?.balanceBefore;
  const after = record?.balanceAfter;
  if (!before || !after || !('weeklyRemainingPercent' in before) || !('weeklyRemainingPercent' in after)) {
    return null;
  }
  return {
    weeklyPercent: before.weeklyRemainingPercent - after.weeklyRemainingPercent,
    sessionPercent: before.sessionRemainingPercent - after.sessionRemainingPercent,
  };
}

/**
 * Metrics for one run, computed only from its trace lines (plus the thread's
 * ledger and the usage log when given). Pure: no file access.
 */
export function computeRunMetrics(input: {
  run: RunSummary;
  lines: TraceLine[];
  ledger?: LedgerEnvelope[];
  usage?: UsageRecord[];
}): RunMetrics {
  const { run, lines } = input;
  const responses = linesOf(lines, 'llm_response');
  const perCall = responses
    .map((line) => line.usage?.promptTokens)
    .filter((value): value is number => typeof value === 'number');
  const sorted = [...perCall].sort((a, b) => a - b);

  const ownPrompt = run.usage?.own.promptTokens ?? perCall.reduce((sum, value) => sum + value, 0);
  const childPrompt = run.usage?.children.promptTokens ?? 0;
  const ownCompletion =
    run.usage?.own.completionTokens ??
    responses.reduce((sum, line) => sum + (line.usage?.completionTokens ?? 0), 0);
  const childCompletion = run.usage?.children.completionTokens ?? 0;
  const totalPrompt = ownPrompt + childPrompt;
  const totalCompletion = ownCompletion + childCompletion;

  const toolsByName: Record<string, number> = {};
  const toolsByStage: Record<string, number> = {};
  for (const start of linesOf(lines, 'tool_start')) {
    count(toolsByName, start.toolName);
    count(toolsByStage, toolStage(start.toolName));
  }

  const editCompletes = linesOf(lines, 'tool_complete').filter(
    (line) => line.toolName === 'edit_file' && isEditSuccess(line.resultPreview),
  );
  const firstEditIteration = editCompletes[0]?.iteration;
  const promptBefore =
    firstEditIteration === undefined
      ? null
      : responses
          .filter((line) => line.iteration <= firstEditIteration)
          .reduce((sum, line) => sum + (line.usage?.promptTokens ?? 0), 0);

  const answer = [...(input.ledger ?? [])]
    .reverse()
    .find((envelope) => envelope.runId === run.runId && envelope.record.role === 'assistant');
  const effort: Record<string, number> = {};
  for (const request of linesOf(lines, 'llm_request')) {
    count(effort, request.reasoningEffort ?? 'default');
  }
  const rereads = reReads(lines);

  return {
    runId: run.runId,
    threadId: run.threadId,
    ...(run.model ? { model: run.model } : {}),
    status: run.status,
    ...(run.limitReason ? { limitReason: run.limitReason } : {}),
    iterations: run.iterations,
    toolCalls: run.toolCalls,
    promptPerCall:
      sorted.length > 0
        ? {
            calls: sorted.length,
            median: percentile(sorted, 50),
            p90: percentile(sorted, 90),
            max: sorted.at(-1)!,
          }
        : null,
    promptTokens: { own: ownPrompt, children: childPrompt, total: totalPrompt },
    completionTokens: { own: ownCompletion, children: childCompletion, total: totalCompletion },
    promptToCompletion: totalCompletion > 0 ? totalPrompt / totalCompletion : null,
    childShare: totalPrompt > 0 ? childPrompt / totalPrompt : null,
    toolsByName,
    toolsByStage,
    networkCalls: toolsByStage.network ?? 0,
    ...(run.durationMs !== undefined ? { wallClockMs: run.durationMs } : {}),
    ...(answer?.runDurationMs !== undefined ? { runDurationMs: answer.runDurationMs } : {}),
    ...(answer?.durationMs !== undefined ? { answerWriteMs: answer.durationMs } : {}),
    edits: editCompletes.length,
    firstEdit:
      firstEditIteration === undefined
        ? null
        : { iteration: firstEditIteration, promptTokensBefore: promptBefore ?? 0 },
    idleShare:
      ownPrompt > 0 ? (promptBefore === null ? 1 : Math.min(1, promptBefore / ownPrompt)) : null,
    readWalks: readWalks(lines),
    recallCalls: rereads.recall,
    reReadsAfterEviction: rereads.total,
    steering: {
      stallNudges: linesOf(lines, 'stall_nudge').length,
      researchGates: linesOf(lines, 'research_gate').length,
      toolNotes: linesOf(lines, 'tool_note').length,
      budgetWarnings: linesOf(lines, 'budget_warning').length,
      evictions: linesOf(lines, 'context_evicted').length,
      inRunCompactions: linesOf(lines, 'context_compacted_inrun').length,
      limits: linesOf(lines, 'limit').map((line) => line.reason),
    },
    reasoningEffort: effort,
    capacity: usageDelta(input.usage?.find((record) => record.runId === run.runId)),
  };
}

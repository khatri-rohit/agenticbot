import type { LedgerEnvelope } from '@agent/agent-models';

import { iterationShape, iterationsOf, PLAN_TOOLS } from '../read/iterations.js';
import type { RunSummary } from '../read/runs.js';
import { linesOf, type TraceLine } from '../read/trace.js';
import type { UsageRecord } from '../read/usage.js';

/** A read walk needs at least this many narrow reads of one file in a row. */
export const READ_WALK_MIN_CALLS = 5;
/** A read with a smaller `limit` (lines) counts as narrow. */
export const READ_WALK_MAX_LIMIT = 40;

export type ReadWalk = { path: string; calls: number; fromIteration: number; toIteration: number };

/** System 1 over one run, from its `system1_decision` and `system1_report` lines. */
export type System1Metrics = {
  mode: 'shadow' | 'enforce';
  /** Requests sent to the scorer (from the report; null when the run has none). */
  calls: number | null;
  decisions: number;
  /** Decisions that changed what was sent to the main model (enforce only). */
  applied: number;
  /** Decisions whose choice differed from the baseline: in shadow, what enforce would have changed. */
  changed: number;
  /** `baseline→chosen` wire values, counted (`default` when unset). */
  transitions: Record<string, number>;
  /** Fallbacks by kind, summed over sites. */
  fallbacks: Record<string, number>;
  latencyMs: { p50: number; p95: number } | null;
};

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
    /** In-run compaction could not get under its low mark. */
    prefixHeavy: number;
    /** Thread compactions after the run (`context_compacted`). */
    threadCompactions: number;
    limits: string[];
  };
  skills: { loaded: number; loadedTokens: number; evicted: number };
  /** `memory_gate` verdicts (`apply` / `reject` / `stage`), counted. */
  memoryGate: Record<string, number>;
  reasoningEffort: Record<string, number>;
  /** Null when the run has no System 1 lines (System 1 off). */
  system1: System1Metrics | null;
  /** Prompt tokens by phase of the work, per model call; null when nothing was edited. */
  phases: { beforeFirstEdit: number; editing: number; afterLastEdit: number } | null;
  /** Model calls by how many tools they asked for. `planOnly`: a single plan/todo call (a ritual iteration). */
  callShape: { answer: number; single: number; multi: number; planOnly: number };
  /** Last call's prompt ÷ first call's, over tool-using calls; null under two calls. */
  promptGrowth: number | null;
  /** The first call's prompt by context layer (`run_start.layers`), in tokens. */
  firstCallLayers: Record<string, number>;
  /** Tools of one parallel batch overlap, so tool-seconds can exceed the wall clock. */
  time: { modelMs: number; toolSeconds: number };
  /** Per tool: calls, calls that failed (classifier `error` or threw), and non-zero command exits. */
  toolOutcomes: Record<string, { calls: number; errors: number; nonZeroExit: number }>;
  /** An edit run ran a command after its last edit; null when nothing was edited. */
  verifiedAfterEdit: boolean | null;
  /**
   * Own prompt tokens no traced call accounts for. Older traces do not trace
   * tools-off final calls (limit handoffs), so their per-call numbers miss them.
   */
  untracedPromptTokens: number;
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

function system1Metrics(lines: TraceLine[]): System1Metrics | null {
  const decisions = linesOf(lines, 'system1_decision').map((line) => line.decision);
  const report = linesOf(lines, 'system1_report').at(-1)?.report;
  const mode = report?.mode ?? decisions[0]?.mode;
  if (!mode) return null;

  const transitions: Record<string, number> = {};
  let changed = 0;
  for (const decision of decisions) {
    const baseline = decision.baseline ?? 'default';
    const chosen = decision.chosen ?? baseline;
    count(transitions, `${baseline}→${chosen}`);
    if (chosen !== baseline) changed += 1;
  }
  const fallbacks: Record<string, number> = {};
  for (const fallback of report?.fallbacks ?? []) {
    fallbacks[fallback.kind] = (fallbacks[fallback.kind] ?? 0) + fallback.count;
  }
  const latencies = decisions
    .map((decision) => decision.latencyMs)
    .filter((value): value is number => typeof value === 'number')
    .sort((a, b) => a - b);
  return {
    mode,
    calls: report?.calls ?? null,
    decisions: decisions.length,
    applied: decisions.filter((decision) => decision.applied).length,
    changed,
    transitions,
    fallbacks,
    latencyMs:
      report?.latencyMs ??
      (latencies.length > 0 ? { p50: percentile(latencies, 50), p95: percentile(latencies, 95) } : null),
  };
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

  const entries = iterationsOf(lines);
  const toolsByName: Record<string, number> = {};
  const toolsByStage: Record<string, number> = {};
  const toolOutcomes: RunMetrics['toolOutcomes'] = {};
  const callShape = { answer: 0, single: 0, multi: 0, planOnly: 0 };
  let modelMs = 0;
  let toolMs = 0;
  let firstEditAt = -1;
  let lastEditAt = -1;
  let lastExecAt = -1;
  let edits = 0;
  entries.forEach((entry, position) => {
    if (entry.request && !entry.final) {
      const shape = iterationShape(entry);
      callShape[shape] += 1;
      if (shape === 'single' && PLAN_TOOLS.has(entry.tools[0]!.name)) callShape.planOnly += 1;
    }
    modelMs += entry.response?.durationMs ?? 0;
    for (const tool of entry.tools) {
      count(toolsByName, tool.name);
      count(toolsByStage, tool.stage);
      toolMs += tool.durationMs ?? 0;
      const outcome = (toolOutcomes[tool.name] ??= { calls: 0, errors: 0, nonZeroExit: 0 });
      outcome.calls += 1;
      if (tool.outcome === 'error' || tool.outcome === 'threw') outcome.errors += 1;
      if (tool.exitCode !== undefined && tool.exitCode !== 0) outcome.nonZeroExit += 1;
      if (tool.name === 'edit_file' && tool.outcome === 'ok') {
        edits += 1;
        if (firstEditAt < 0) firstEditAt = position;
        lastEditAt = position;
      }
      if (tool.stage === 'exec') lastExecAt = position;
    }
  });
  const firstEditIteration = firstEditAt >= 0 ? entries[firstEditAt]!.iteration : undefined;
  let phases: RunMetrics['phases'] = null;
  if (firstEditAt >= 0) {
    phases = { beforeFirstEdit: 0, editing: 0, afterLastEdit: 0 };
    entries.forEach((entry, position) => {
      const prompt = entry.response?.usage?.promptTokens ?? 0;
      if (position <= firstEditAt) phases!.beforeFirstEdit += prompt;
      else if (position <= lastEditAt) phases!.editing += prompt;
      else phases!.afterLastEdit += prompt;
    });
  }
  const toolCallPrompts = entries
    .filter((entry) => !entry.final && entry.tools.length > 0)
    .map((entry) => entry.response?.usage?.promptTokens)
    .filter((value): value is number => typeof value === 'number' && value > 0);
  const firstCallLayers: Record<string, number> = {};
  for (const layer of linesOf(lines, 'run_start')[0]?.layers ?? []) firstCallLayers[layer.id] = layer.tokens;
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
  const skillsLoaded = linesOf(lines, 'skill_loaded');
  const memoryGate: Record<string, number> = {};
  for (const gate of linesOf(lines, 'memory_gate')) count(memoryGate, gate.verdict);

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
    edits,
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
      prefixHeavy: linesOf(lines, 'context_prefix_heavy').length,
      threadCompactions: linesOf(lines, 'context_compacted').length,
      limits: linesOf(lines, 'limit').map((line) => line.reason),
    },
    skills: {
      loaded: skillsLoaded.length,
      loadedTokens: skillsLoaded.reduce((sum, line) => sum + line.tokens, 0),
      evicted: linesOf(lines, 'skill_evicted').length,
    },
    memoryGate,
    reasoningEffort: effort,
    system1: system1Metrics(lines),
    phases,
    callShape,
    promptGrowth: toolCallPrompts.length >= 2 ? toolCallPrompts.at(-1)! / toolCallPrompts[0]! : null,
    firstCallLayers,
    time: { modelMs, toolSeconds: Math.round(toolMs / 100) / 10 },
    toolOutcomes,
    verifiedAfterEdit: lastEditAt < 0 ? null : lastExecAt >= lastEditAt,
    untracedPromptTokens: Math.max(0, ownPrompt - perCall.reduce((sum, value) => sum + value, 0)),
    capacity: usageDelta(input.usage?.find((record) => record.runId === run.runId)),
  };
}

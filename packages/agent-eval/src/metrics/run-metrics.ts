import type { TraceEvent } from '@agent/agent-models';
import type { RunSummary } from '../read/runs.js';
import type { UsageRecord } from '../read/usage.js';

export type ToolHistogramEntry = {
  name: string;
  count: number;
  /** 'read' | 'write' | 'search' | 'network' | 'delegate' | 'other' */
  stage: string;
};

export type RunMetrics = {
  runId: string;
  threadId: string;
  model: string;
  iterations: number;
  toolCalls: number;
  toolHistogram: ToolHistogramEntry[];
  promptTokens: {
    perCall: number[];
    median: number;
    p90: number;
    max: number;
    total: number;
  };
  childPromptTokens: number;
  childShare: number;
  wallMs: number;
  /** Prompt tokens before the first successful edit ÷ total prompt tokens. */
  idleShare: number;
  /** Tokens and time to the first successful edit_file (Created/Patched). */
  firstEditAt?: { tokens: number; ms: number; seq: number };
  /** Re-reads of paths that were evicted (recall + read_file of evicted path). */
  reReadsAfterEviction: number;
  /** Steering events: stall_nudge, research_gate, tool_note, budget_warning. */
  steering: { stallNudge: number; researchGate: number; toolNote: number; budgetWarning: number };
  /** Limit reasons seen in the trace. */
  limits: string[];
  /** Per-call reasoning effort distribution (L1 observability). */
  reasoningEffort: Record<string, number>;
  /** Capacity cost from usage.jsonl, if available. */
  capacityCost?: { promptTokens: number; completionTokens: number };
  finishReason?: string;
};

const WRITE_TOOLS = new Set(['edit_file', 'write_file', 'create_file']);
const READ_TOOLS = new Set(['read_file', 'recall']);
const SEARCH_TOOLS = new Set(['grep', 'glob']);
const NETWORK_TOOLS = new Set(['web_search', 'web_fetch']);
const DELEGATE_TOOLS = new Set(['delegate']);

function toolStage(name: string): string {
  if (WRITE_TOOLS.has(name)) return 'write';
  if (READ_TOOLS.has(name)) return 'read';
  if (SEARCH_TOOLS.has(name)) return 'search';
  if (NETWORK_TOOLS.has(name)) return 'network';
  if (DELEGATE_TOOLS.has(name)) return 'delegate';
  return 'other';
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(Math.ceil(sorted.length * p) - 1, sorted.length - 1);
  return sorted[idx];
}

type EvictionEvent = Extract<TraceEvent, { type: 'context_evicted' }>;
type ToolStartEvent = Extract<TraceEvent, { type: 'tool_start' }>;
type ToolCompleteEvent = Extract<TraceEvent, { type: 'tool_complete' }>;

/**
 * Compute RunMetrics from a RunSummary's events + optional usage record.
 * Pure function — no I/O. This is the single computation point for E1.
 */
export function computeRunMetrics(
  run: RunSummary,
  usage?: UsageRecord,
): RunMetrics {
  const events = run.events;
  const promptPerCall: number[] = [];
  const effortCounts: Record<string, number> = {};
  const toolCounts: Record<string, number> = {};
  const limits: string[] = [];
  let firstEditTokens = 0;
  let firstEditMs = 0;
  let firstEditSeq: number | undefined;
  let firstEditFound = false;
  let cumulativePrompt = 0;
  let steering = { stallNudge: 0, researchGate: 0, toolNote: 0, budgetWarning: 0 };
  let reReadsAfterEviction = 0;
  let finishReason: string | undefined;
  const evictedPaths = new Set<string>();
  let runStartTs: number | undefined;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const seq = i; // events are already sorted by seq or file order

    if (event.type === 'run_start') {
      const e = event as Extract<TraceEvent, { type: 'run_start' }>;
      runStartTs = e.ts ? new Date(e.ts).getTime() : undefined;
    } else if (event.type === 'llm_request') {
      const e = event as Extract<TraceEvent, { type: 'llm_request' }>;
      const tokens = e.estimatedPromptTokens ?? 0;
      promptPerCall.push(tokens);
      cumulativePrompt += tokens;
      if (e.reasoningEffort) {
        effortCounts[e.reasoningEffort] = (effortCounts[e.reasoningEffort] ?? 0) + 1;
      }
    } else if (event.type === 'tool_call') {
      const e = event as ToolCallEvent;
      toolCounts[e.name] = (toolCounts[e.name] ?? 0) + 1;
    } else if (event.type === 'tool_complete') {
      const e = event as ToolCompleteEvent;
      if (!firstEditFound && WRITE_TOOLS.has(e.name)) {
        firstEditFound = true;
        firstEditTokens = cumulativePrompt;
        firstEditSeq = seq;
        if (runStartTs && e.ts) {
          firstEditMs = new Date(e.ts).getTime() - runStartTs;
        }
      }
    } else if (event.type === 'context_evicted') {
      const e = event as EvictionEvent;
      if (e.path) evictedPaths.add(e.path);
    } else if (event.type === 'tool_call') {
      const e = event as ToolCallEvent;
      if (READ_TOOLS.has(e.name) && typeof e.args === 'object' && e.args !== null) {
        const argPath = (e.args as { path?: string }).path;
        if (argPath && evictedPaths.has(argPath)) reReadsAfterEviction++;
      }
    } else if (event.type === 'stall_nudge') {
      steering.stallNudge++;
    } else if (event.type === 'research_gate') {
      steering.researchGate++;
    } else if (event.type === 'tool_note') {
      steering.toolNote++;
    } else if (event.type === 'budget_warning') {
      steering.budgetWarning++;
    } else if (event.type === 'limit') {
      const e = event as Extract<TraceEvent, { type: 'limit' }>;
      if (e.reason) limits.push(e.reason);
    } else if (event.type === 'run_settled') {
      const e = event as Extract<TraceEvent, { type: 'run_settled' }>;
      if (e.finishReason) finishReason = e.finishReason;
    }
  }

  const total = promptPerCall.reduce((a, b) => a + b, 0);
  const toolHistogram: ToolHistogramEntry[] = Object.entries(toolCounts)
    .map(([name, count]) => ({ name, count, stage: toolStage(name) }))
    .sort((a, b) => b.count - a.count);

  const idleShare = total > 0 && firstEditFound
    ? firstEditTokens / total
    : total > 0
      ? 1
      : 0;

  return {
    runId: run.runId,
    threadId: run.threadId,
    model: run.model,
    iterations: run.iterations,
    toolCalls: run.toolCalls,
    toolHistogram,
    promptTokens: {
      perCall: promptPerCall,
      median: median(promptPerCall),
      p90: percentile(promptPerCall, 0.9),
      max: promptPerCall.length > 0 ? Math.max(...promptPerCall) : 0,
      total,
    },
    childPromptTokens: run.promptTokensChildren,
    childShare: total + run.promptTokensChildren > 0
      ? run.promptTokensChildren / (total + run.promptTokensChildren)
      : 0,
    wallMs: run.durationMs,
    idleShare,
    ...(firstEditSeq !== undefined
      ? { firstEditAt: { tokens: firstEditTokens, ms: firstEditMs, seq: firstEditSeq } }
      : {}),
    reReadsAfterEviction,
    steering,
    limits,
    reasoningEffort: effortCounts,
    ...(usage?.usage
      ? {
          capacityCost: {
            promptTokens: usage.usage.promptTokens ?? 0,
            completionTokens: usage.usage.completionTokens ?? 0,
          },
        }
      : {}),
    ...(finishReason ? { finishReason } : {}),
  };
}
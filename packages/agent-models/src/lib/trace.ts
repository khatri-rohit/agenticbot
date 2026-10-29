import type { ContextReportLayer, ContextWindowSource } from './context.js';
import type { RunUsage, TokenUsage } from './run.js';

/**
 * Bumped when a TraceEvent field changes meaning or is removed. Adding an
 * optional field does not bump it. Sinks stamp every line with `v`, so an
 * offline reader (eval / observability app) can parse old traces.
 */
export const TRACE_SCHEMA_VERSION = 2;

/**
 * Internal execution trace events (console / eval harness / JSONL sink).
 *
 * Distinct from AgentEvent, which is the product protocol for SSE and UI.
 * Both may be emitted during a run. TraceEvents are the observability surface
 * for offline replay and eval debugging — they never flow over SSE.
 */
export type TraceEvent =
  | {
      type: 'run_start';
      runId: string;
      model: string;
      threadId?: string;
      /** Set on sub-agent runs; the parent's runId. */
      parentRunId?: string;
      /** 0 for a user run, 1 for its sub-agents. */
      depth?: number;
      mode?: string;
      posture?: string;
      windowTokens?: number;
      windowSource?: ContextWindowSource;
      /** Prompt size of the first call, split by context layer. */
      occupiedTokens?: number;
      layers?: ContextReportLayer[];
    }
  | {
      type: 'llm_request';
      runId: string;
      iteration: number;
      /** Heuristic size of the prompt about to be sent. */
      estimatedPromptTokens?: number;
    }
  | {
      type: 'llm_response';
      runId: string;
      iteration: number;
      finishReason: string | null;
      hasToolCalls: boolean;
      contentPreview?: string;
      /** Provider-reported token counts for this iteration, when available. */
      usage?: TokenUsage;
      /** Model call + stream time. */
      durationMs?: number;
      /** Provider sent no usage; the run charged the local estimate. */
      usageEstimated?: boolean;
    }
  | {
      type: 'tool_start';
      runId: string;
      iteration: number;
      toolName: string;
      args: unknown;
    }
  | {
      type: 'tool_complete';
      runId: string;
      iteration: number;
      toolName: string;
      durationMs: number;
      resultPreview: string;
      /** Full result length before any preview clipping. */
      resultChars?: number;
    }
  | {
      type: 'tool_error';
      runId: string;
      iteration: number;
      toolName: string;
      error: string;
    }
  | {
      type: 'limit';
      runId: string;
      iteration: number;
      reason: string;
    }
  | {
      type: 'run_finish';
      runId: string;
      iterations: number;
      toolCalls: number;
      status?: string;
      limitReason?: string;
      usage?: RunUsage;
      durationMs?: number;
    }
  | {
      type: 'memory_gate';
      runId: string;
      /** Loop iteration; omitted when a tool emits outside the loop closure. */
      iteration?: number;
      toolName: 'memory';
      target: 'user' | 'notes' | 'project' | 'skill';
      verdict: 'apply' | 'reject' | 'stage';
      why: string;
    }
  | {
      type: 'context_compacted';
      runId: string;
      threadId: string;
      throughSeq: number;
      briefPreview: string;
    }
  | {
      /** In-run eviction of old tool results into cards. */
      type: 'context_evicted';
      runId: string;
      iteration: number;
      evicted: number;
      beforeTokens: number;
      afterTokens: number;
    }
  | {
      /** In-run extractive compaction of older iterations of this turn. */
      type: 'context_compacted_inrun';
      runId: string;
      iteration: number;
      beforeTokens: number;
      afterTokens: number;
    }
  | {
      type: 'skill_loaded';
      runId: string;
      iteration?: number;
      name: string;
      section?: string;
      tokens: number;
      source: 'model' | 'pick' | 'profile';
    }
  | {
      type: 'skill_evicted';
      runId: string;
      iteration: number;
      name: string;
      residentIterations: number;
    }
  | {
      /** In-run compaction cannot get under its low mark; stopped for this run. */
      type: 'context_prefix_heavy';
      runId: string;
      iteration: number;
      promptTokens: number;
    }
  | {
      type: 'budget_warning';
      runId: string;
      iteration: number;
      reason: string;
      promptTokens: number;
      limitPromptTokens?: number;
    };

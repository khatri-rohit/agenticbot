import type { TokenUsage } from './run.js';

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
    }
  | {
      type: 'llm_request';
      runId: string;
      iteration: number;
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
    };
/**
 * Internal execution trace events (console / eval harness).
 *
 * Distinct from AgentEvent (@org/agent-models), which is the product protocol
 * for SSE and UI. Both may be emitted during a run.
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
    };

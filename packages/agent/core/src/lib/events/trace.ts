/**
 * TraceEvent — internal execution trace for console logging and eval harness.
 *
 * This is the *internal* trace shape (pre-event-protocol). Phase 4 replaces
 * this with the AgentEvent emitter, but for Phase 2 we preserve the existing
 * trace interface so the eval harness works unchanged.
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

export function consoleTrace(event: TraceEvent): void {
  const prefix = `[agent:${event.runId}]`;

  switch (event.type) {
    case 'run_start':
      console.log(`${prefix} START model=${event.model}`);
      break;

    case 'llm_request':
      console.log(`${prefix} LLM request iteration=${event.iteration}`);
      break;

    case 'llm_response':
      console.log(
        `${prefix} LLM response iteration=${event.iteration}` +
          ` finish=${event.finishReason}` +
          ` toolCalls=${event.hasToolCalls}`,
      );
      if (event.contentPreview) {
        console.log(`${prefix} content=${event.contentPreview}`);
      }
      break;

    case 'tool_start':
      console.log(`${prefix} TOOL ${event.toolName}`, event.args);
      break;

    case 'tool_complete':
      console.log(
        `${prefix} TOOL COMPLETE ${event.toolName}` +
          ` duration=${event.durationMs}ms`,
      );
      console.log(`${prefix} result=${event.resultPreview}`);
      break;

    case 'tool_error':
      console.error(`${prefix} TOOL ERROR ${event.toolName}: ${event.error}`);
      break;

    case 'limit':
      console.warn(
        `${prefix} LIMIT iteration=${event.iteration}` +
          ` reason=${event.reason}`,
      );
      break;

    case 'run_finish':
      console.log(
        `${prefix} FINISH iterations=${event.iterations}` +
          ` toolCalls=${event.toolCalls}`,
      );
      break;
  }
}

import type { TraceEvent } from './trace-types';

export type { TraceEvent } from './trace-types';

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

import type { Snapshot, TokenUsage } from '@agent/agent-models';

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
      if (event.usage) {
        console.log(`${prefix} usage=${formatUsage(event.usage)}`);
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

    case 'memory_gate':
      console.log(
        `${prefix} MEMORY GATE ${event.target} → ${event.verdict}` +
          ` (${event.why})`,
      );
      break;

    case 'context_compacted':
      console.log(
        `${prefix} COMPACTED throughSeq=${event.throughSeq}` +
          ` brief=${event.briefPreview}`,
      );
      break;
  }
}

function formatUsage(usage: TokenUsage): string {
  const total =
    usage.totalTokens ??
    usage.promptTokens + usage.completionTokens;
  return `prompt=${usage.promptTokens} completion=${usage.completionTokens} total=${total}`;
}

/**
 * Fan a TraceEvent to multiple sinks. Null/undefined sinks are dropped so
 * hosts can compose `teeTrace(consoleTrace, jsonlSink)` without conditionals.
 */
export function teeTrace(
  ...sinks: (((event: TraceEvent) => void) | null | undefined)[]
): (event: TraceEvent) => void {
  const live = sinks.filter(
    (sink): sink is (event: TraceEvent) => void => typeof sink === 'function',
  );
  return (event) => {
    for (const sink of live) sink(event);
  };
}

const BRIEF_PREVIEW_MAX = 200;

/**
 * Build the `context_compacted` trace event from a host-written snapshot.
 * Hosts call this with their trace sink after `buildExtractiveSnapshot`.
 */
export function traceCompactionEvent(input: {
  runId: string;
  threadId: string;
  snapshot: Snapshot;
}): TraceEvent {
  const brief = input.snapshot.brief ?? '';
  return {
    type: 'context_compacted',
    runId: input.runId,
    threadId: input.threadId,
    throughSeq: input.snapshot.throughSeq,
    briefPreview:
      brief.length > BRIEF_PREVIEW_MAX
        ? `${brief.slice(0, BRIEF_PREVIEW_MAX)}…`
        : brief,
  };
}

import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

import type {
  AgentEventWithoutSeq,
  LedgerAppendMeta,
  ToolOutcome,
} from '@agent/agent-models';

/** Cap for refusal and skip texts on the event stream. */
const NOTICE_PREVIEW_MAX = 200;

export function preview(value: unknown, max = 300): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function nameOf(toolCall: ChatCompletionMessageToolCall): string {
  return toolCall.type === 'function' ? toolCall.function.name : toolCall.type;
}

/**
 * The observable life of each tool call in one run: a `tool.started` /
 * `tool.completed` (or `tool.failed`) pair on the stream and exactly one
 * durable row carrying its outcome (I1). The live view and the ledger see
 * the same calls with the same outcomes.
 */
export class ToolCallRecord {
  private readonly started = new Set<string>();
  private readonly answered = new Set<string>();

  constructor(
    private readonly runId: string,
    private readonly emit: ((event: AgentEventWithoutSeq) => void) | undefined,
    private readonly append: (
      message: ChatCompletionMessageParam,
      meta?: LedgerAppendMeta,
    ) => Promise<void>,
    /** Args preview for calls that never ran (the loop owns the format). */
    private readonly argsPreviewOf: (toolCall: ChatCompletionMessageToolCall) => string,
  ) {}

  isAnswered(toolCallId: string): boolean {
    return this.answered.has(toolCallId);
  }

  unanswered(
    toolCalls: ChatCompletionMessageToolCall[],
  ): ChatCompletionMessageToolCall[] {
    return toolCalls.filter((toolCall) => !this.answered.has(toolCall.id));
  }

  /** A call is about to run. */
  start(toolCallId: string, toolName: string, argsPreview: string): void {
    this.started.add(toolCallId);
    this.emit?.({
      type: 'tool.started',
      runId: this.runId,
      toolCallId,
      toolName,
      argsPreview,
    });
  }

  /** A started call returned (`skipped` when the user skipped a choice). */
  async complete(
    toolCallId: string,
    toolName: string,
    content: string,
    durationMs: number,
    resultPreview: string,
    outcome: Exclude<ToolOutcome, 'failed'> = 'ok',
  ): Promise<void> {
    this.emit?.({
      type: 'tool.completed',
      runId: this.runId,
      toolCallId,
      toolName,
      durationMs,
      resultPreview,
      outcome,
    });
    await this.row(toolCallId, content, outcome);
  }

  /** A started call threw. */
  async fail(toolCallId: string, errorMessage: string): Promise<void> {
    this.emit?.({
      type: 'tool.failed',
      runId: this.runId,
      toolCallId,
      error: errorMessage,
    });
    await this.row(toolCallId, `Tool execution failed: ${errorMessage}`, 'failed');
  }

  /** A gate said no before the call ran. */
  async refuse(
    toolCall: ChatCompletionMessageToolCall,
    content: string,
  ): Promise<void> {
    await this.close(toolCall, content, 'refused');
  }

  /** Calls that will never run (halt, cancel, deferred choice, error). */
  async skip(
    toolCalls: ChatCompletionMessageToolCall[],
    reason: string,
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      if (this.answered.has(toolCall.id)) continue;
      await this.close(toolCall, reason, 'skipped');
    }
  }

  private async close(
    toolCall: ChatCompletionMessageToolCall,
    content: string,
    outcome: 'refused' | 'skipped',
  ): Promise<void> {
    const toolName = nameOf(toolCall);
    if (!this.started.has(toolCall.id)) {
      this.start(toolCall.id, toolName, this.argsPreviewOf(toolCall));
    }
    await this.complete(
      toolCall.id,
      toolName,
      content,
      0,
      preview(content, NOTICE_PREVIEW_MAX),
      outcome,
    );
  }

  private async row(
    toolCallId: string,
    content: string,
    toolOutcome: ToolOutcome,
  ): Promise<void> {
    if (this.answered.has(toolCallId)) return;
    this.answered.add(toolCallId);
    await this.append(
      { role: 'tool', tool_call_id: toolCallId, content },
      { toolOutcome },
    );
  }
}

import { randomUUID } from 'node:crypto';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

import { consoleTrace, type TraceEvent } from '../events/trace';
import type { AgentEventWithoutSeq } from '@org/agent-models';
import { DEFAULT_LIMITS, type AgentLimits } from './limits';
import { ToolRegistry } from '../tools/type';

/* ---------- public types ---------- */

export type ModelTurn = {
  content: string;
  toolCalls: ChatCompletionMessageToolCall[];
  finishReason: string | null;
};

/**
 * Function signature for a model call. The loop is transport-agnostic.
 * onTextDelta is provided at call time so the loop controls messageId
 * and can wire it to assistant.delta events.
 */
export type ModelCallFn = (
  model: string,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  onTextDelta?: (delta: string) => void,
) => Promise<ModelTurn>;

export type RunLoopConfig = {
  runId?: string;
  threadId?: string;
  model: string;
  streaming: boolean;
  limits?: Partial<AgentLimits>;
  /** Legacy trace callback (eval harness). Kept for backward compat. */
  trace?: (event: TraceEvent) => void;
  /** Event emitter callback (Phase 4+). If provided, emits AgentEvents. */
  emit?: (event: AgentEventWithoutSeq) => void;
};

export type RunLoopResult = {
  runId: string;
  content: string;
  iterations: number;
  toolCalls: number;
  status: 'completed' | 'error';
};

/* ---------- internal helpers ---------- */

function preview(value: unknown, max = 300): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function toolCallKey(toolName: string, args: unknown): string {
  return `${toolName}:${JSON.stringify(args)}`;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Tool timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
}

function skipToolCalls(
  messages: ChatCompletionMessageParam[],
  toolCalls: ChatCompletionMessageToolCall[],
  reason: string,
): void {
  for (const toolCall of toolCalls) {
    messages.push({ role: 'tool', tool_call_id: toolCall.id, content: reason });
  }
}

/* ---------- the loop ---------- */

/**
 * The agent state machine. Iterates: model call → tool execution → next model call.
 *
 * Emits AgentEvents via config.emit (for SSE/UI) AND traces via config.trace
 * (for eval/console). Both are optional — the loop works with either or both.
 */
export async function runLoop(
  modelCall: ModelCallFn,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  config: RunLoopConfig,
): Promise<RunLoopResult> {
  const limits = { ...DEFAULT_LIMITS, ...config.limits };
  const trace = config.trace ?? ((event: TraceEvent) => consoleTrace(event));
  const emit = config.emit;
  const runId = config.runId ?? randomUUID();
  const threadId = config.threadId ?? 'unknown';

  let iterations = 0;
  let totalToolCalls = 0;
  const repeatedCalls = new Map<string, number>();

  trace({ type: 'run_start', runId, model: config.model });
  emit?.({
    type: 'run.started',
    runId,
    threadId,
    mode: 'research',
    streaming: config.streaming,
    model: config.model,
  });

  try {
    while (iterations < limits.maxIterations) {
      iterations++;

      trace({ type: 'llm_request', runId, iteration: iterations });
      emit?.({ type: 'turn.started', runId, iteration: iterations });

      const messageId = randomUUID();
      const onTextDelta = config.streaming
        ? (delta: string) => {
            emit?.({
              type: 'assistant.delta',
              runId,
              messageId,
              delta,
            });
          }
        : undefined;

      if (config.streaming) {
        emit?.({ type: 'assistant.started', runId, messageId });
      }

      const turn = await modelCall(config.model, messages, tools, onTextDelta);

      trace({
        type: 'llm_response',
        runId,
        iteration: iterations,
        finishReason: turn.finishReason,
        hasToolCalls: Boolean(turn.toolCalls.length),
        contentPreview: turn.content ? preview(turn.content) : undefined,
      });

      if (turn.toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: turn.content || null,
          tool_calls: turn.toolCalls,
        });

        for (const [index, toolCall] of turn.toolCalls.entries()) {
          if (toolCall.type !== 'function') {
            continue;
          }

          totalToolCalls++;

          if (totalToolCalls > limits.maxToolCalls) {
            trace({
              type: 'limit',
              runId,
              iteration: iterations,
              reason: `max tool calls exceeded (${limits.maxToolCalls})`,
            });
            emit?.({
              type: 'limit.hit',
              runId,
              reason: `max tool calls exceeded (${limits.maxToolCalls})`,
            });

            skipToolCalls(
              messages,
              turn.toolCalls.slice(index),
              'Skipped: tool call limit reached.',
            );

            const finalContent = await finalizeWithoutTools(
              modelCall,
              config.model,
              messages,
            );

            emit?.({
              type: 'assistant.completed',
              runId,
              messageId,
              content: turn.content,
            });

            trace({
              type: 'run_finish',
              runId,
              iterations,
              toolCalls: totalToolCalls,
            });
            emit?.({
              type: 'turn.completed',
              runId,
              iteration: iterations,
            });
            emit?.({
              type: 'run.completed',
              runId,
              iterations,
              toolCalls: totalToolCalls,
            });

            return {
              runId,
              content: finalContent,
              iterations,
              toolCalls: totalToolCalls,
              status: 'completed',
            };
          }

          const toolName = toolCall.function.name;
          const tool = tools.byName.get(toolName);

          if (!tool) {
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Tool "${toolName}" does not exist.`,
            });
            continue;
          }

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: 'Invalid tool arguments. Expected valid JSON.',
            });
            continue;
          }

          const callKey = toolCallKey(toolName, args);
          const repeatCount = (repeatedCalls.get(callKey) ?? 0) + 1;
          repeatedCalls.set(callKey, repeatCount);

          if (repeatCount > limits.maxRepeatedToolCalls) {
            trace({
              type: 'limit',
              runId,
              iteration: iterations,
              reason: `repeated tool call blocked: ${toolName}`,
            });
            emit?.({
              type: 'limit.hit',
              runId,
              reason: `repeated tool call blocked: ${toolName}`,
            });

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content:
                'This exact tool call has already been attempted multiple times. Do not repeat it.',
            });

            skipToolCalls(
              messages,
              turn.toolCalls.slice(index + 1),
              'Skipped: tool call limit reached.',
            );

            const finalContent = await finalizeWithoutTools(
              modelCall,
              config.model,
              messages,
            );

            trace({
              type: 'run_finish',
              runId,
              iterations,
              toolCalls: totalToolCalls,
            });
            emit?.({
              type: 'turn.completed',
              runId,
              iteration: iterations,
            });
            emit?.({
              type: 'run.completed',
              runId,
              iterations,
              toolCalls: totalToolCalls,
            });

            return {
              runId,
              content: finalContent,
              iterations,
              toolCalls: totalToolCalls,
              status: 'completed',
            };
          }

          trace({
            type: 'tool_start',
            runId,
            iteration: iterations,
            toolName,
            args,
          });
          emit?.({
            type: 'tool.started',
            runId,
            toolCallId: toolCall.id,
            toolName,
            argsPreview: preview(args, 200),
          });

          const startedAt = Date.now();

          try {
            const result = await withTimeout(
              tool.execute(args),
              limits.toolTimeoutMs,
            );

            trace({
              type: 'tool_complete',
              runId,
              iteration: iterations,
              toolName,
              durationMs: Date.now() - startedAt,
              resultPreview: preview(result),
            });
            emit?.({
              type: 'tool.completed',
              runId,
              toolCallId: toolCall.id,
              toolName,
              durationMs: Date.now() - startedAt,
              resultPreview: preview(result, 200),
            });

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result,
            });
          } catch (error) {
            const errorMessage =
              error instanceof Error ? error.message : String(error);

            trace({
              type: 'tool_error',
              runId,
              iteration: iterations,
              toolName,
              error: errorMessage,
            });
            emit?.({
              type: 'tool.failed',
              runId,
              toolCallId: toolCall.id,
              error: errorMessage,
            });

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Tool execution failed: ${errorMessage}`,
            });
          }
        }

        emit?.({ type: 'turn.completed', runId, iteration: iterations });
        continue;
      }

      // No tool calls — this is the final assistant response.
      emit?.({
        type: 'assistant.completed',
        runId,
        messageId,
        content: turn.content,
      });

      if (turn.finishReason === 'stop') {
        const result = turn.content ?? '';

        trace({
          type: 'run_finish',
          runId,
          iterations,
          toolCalls: totalToolCalls,
        });
        emit?.({ type: 'turn.completed', runId, iteration: iterations });
        emit?.({
          type: 'run.completed',
          runId,
          iterations,
          toolCalls: totalToolCalls,
        });

        return {
          runId,
          content: result,
          iterations,
          toolCalls: totalToolCalls,
          status: 'completed',
        };
      }

      trace({
        type: 'limit',
        runId,
        iteration: iterations,
        reason: `unexpected finish reason: ${turn.finishReason}`,
      });
      emit?.({
        type: 'limit.hit',
        runId,
        reason: `unexpected finish reason: ${turn.finishReason}`,
      });
      emit?.({ type: 'turn.completed', runId, iteration: iterations });
      emit?.({
        type: 'run.completed',
        runId,
        iterations,
        toolCalls: totalToolCalls,
      });

      return {
        runId,
        content: turn.content ?? '',
        iterations,
        toolCalls: totalToolCalls,
        status: 'completed',
      };
    }

    // Max iterations exceeded — finalize without tools.
    trace({
      type: 'limit',
      runId,
      iteration: iterations,
      reason: `max iterations exceeded (${limits.maxIterations})`,
    });
    emit?.({
      type: 'limit.hit',
      runId,
      reason: `max iterations exceeded (${limits.maxIterations})`,
    });

    const finalContent = await finalizeWithoutTools(
      modelCall,
      config.model,
      messages,
    );

    trace({
      type: 'run_finish',
      runId,
      iterations,
      toolCalls: totalToolCalls,
    });
    emit?.({ type: 'turn.completed', runId, iteration: iterations });
    emit?.({
      type: 'run.completed',
      runId,
      iterations,
      toolCalls: totalToolCalls,
    });

    return {
      runId,
      content: finalContent,
      iterations,
      toolCalls: totalToolCalls,
      status: 'completed',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    trace({
      type: 'tool_error',
      runId,
      iteration: iterations,
      toolName: 'agent',
      error: message,
    });
    emit?.({ type: 'run.error', runId, error: message });

    return {
      runId,
      content: `Agent error: ${message}`,
      iterations,
      toolCalls: totalToolCalls,
      status: 'error',
    };
  }
}

async function finalizeWithoutTools(
  modelCall: ModelCallFn,
  model: string,
  messages: ChatCompletionMessageParam[],
): Promise<string> {
  messages.push({
    role: 'user',
    content:
      'Tool budget reached. Answer my original question now using only the information above, and say what is uncertain.',
  });

  const turn = await modelCall(model, messages, {
    definitions: [],
    byName: new Map(),
  });

  return turn.content ?? '';
}

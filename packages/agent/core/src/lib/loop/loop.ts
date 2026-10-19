import { randomUUID } from 'node:crypto';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

import {
  isAskStrippedTool,
  type TokenUsage,
  type ToolContext,
} from '@org/agent-models';

import { consoleTrace, type TraceEvent } from '../events/trace';
import { DEFAULT_LIMITS } from './limits';
import type { ModelTurn } from '../model/types';
import type { ToolRegistry } from '../tools/type';
import { toLedgerRecord } from './to-ledger-record';
import type { ModelCallFn, RunLoopConfig, RunLoopResult } from './types';

export type {
  ModelCallFn,
  RunLoopConfig,
  RunLoopResult,
  RunLoopStatus,
} from './types';

/* ---------- internal helpers ---------- */

function preview(value: unknown, max = 300): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

/** Compact preview so UI labels are not poisoned by truncated newText/oldText. */
function toolArgsPreview(toolName: string, args: unknown): string {
  if (
    toolName === 'edit_file' &&
    args &&
    typeof args === 'object' &&
    !Array.isArray(args)
  ) {
    const record = args as Record<string, unknown>;
    const path = typeof record.path === 'string' ? record.path : '';
    const oldText = typeof record.oldText === 'string' ? record.oldText : '';
    const intent = oldText.length > 0 ? 'patch' : 'create';
    return preview({ path, intent }, 200);
  }
  if (
    (toolName === 'plan' || toolName === 'todo') &&
    args &&
    typeof args === 'object' &&
    !Array.isArray(args)
  ) {
    const record = args as Record<string, unknown>;
    if (toolName === 'plan') {
      return preview(
        {
          action: record.action,
          kind: record.kind,
          text:
            typeof record.text === 'string'
              ? record.text.slice(0, 80)
              : undefined,
        },
        200,
      );
    }
    const todos = Array.isArray(record.todos) ? record.todos.length : 0;
    return preview({ merge: record.merge, todos }, 200);
  }
  return preview(args, 200);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

function toolCallKey(toolName: string, args: unknown): string {
  return `${toolName}:${canonicalJson(args)}`;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Run cancelled');
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    return Promise.reject(
      signal.reason instanceof Error
        ? signal.reason
        : new Error('Run cancelled'),
    );
  }

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Tool timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const onAbort = () => {
      cleanup();
      reject(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error('Run cancelled'),
      );
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/* ---------- the loop ---------- */

/**
 * The agent state machine. Iterates: model call → tool execution → next model call.
 *
 * Emits AgentEvents via config.emit (for SSE/UI) AND traces via config.trace
 * (for eval/console). Both are optional — the loop works with either or both.
 * Durable turns go through config.onMessage (host persistence seam).
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
  const signal = config.signal;
  const origin = config.origin ?? 'chat';

  let iterations = 0;
  let totalToolCalls = 0;
  const repeatedCalls = new Map<string, number>();

  async function appendDurable(
    message: ChatCompletionMessageParam,
  ): Promise<void> {
    messages.push(message);
    if (config.onMessage) {
      await config.onMessage(toLedgerRecord(message));
    }
  }

  async function skipToolCalls(
    toolCalls: ChatCompletionMessageToolCall[],
    reason: string,
  ): Promise<void> {
    for (const toolCall of toolCalls) {
      await appendDurable({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: reason,
      });
    }
  }

  function buildToolContext(): ToolContext {
    return {
      runId,
      threadId,
      origin,
      signal: signal ?? new AbortController().signal,
      ...(config.workspaceRoot !== undefined
        ? { workspaceRoot: config.workspaceRoot }
        : {}),
    };
  }

  function emitTurnCompleted(iteration: number, usage?: TokenUsage): void {
    emit?.({
      type: 'turn.completed',
      runId,
      iteration,
      ...(usage ? { usage } : {}),
    });
  }

  /** Fresh message lifecycle for limit finalization (never reuse the tool-turn id). */
  async function finalizeAnswer(): Promise<{
    content: string;
    usage?: TokenUsage;
  }> {
    const finalMessageId = randomUUID();
    const onTextDelta = config.streaming
      ? (delta: string) => {
          emit?.({
            type: 'assistant.delta',
            runId,
            messageId: finalMessageId,
            delta,
          });
        }
      : undefined;

    if (config.streaming) {
      emit?.({ type: 'assistant.started', runId, messageId: finalMessageId });
    }

    const turn = await finalizeWithoutTools(
      modelCall,
      config.model,
      messages,
      onTextDelta,
      signal,
    );
    const content = turn.content ?? '';

    await appendDurable({
      role: 'assistant',
      content,
    });

    emit?.({
      type: 'assistant.completed',
      runId,
      messageId: finalMessageId,
      content,
    });

    return { content, usage: turn.usage };
  }

  async function completeAfterLimit(): Promise<RunLoopResult> {
    const final = await finalizeAnswer();
    trace({
      type: 'run_finish',
      runId,
      iterations,
      toolCalls: totalToolCalls,
    });
    emitTurnCompleted(iterations, final.usage);
    emit?.({
      type: 'run.completed',
      runId,
      iterations,
      toolCalls: totalToolCalls,
      incomplete: true,
    });
    return {
      runId,
      content: final.content,
      iterations,
      toolCalls: totalToolCalls,
      status: 'incomplete',
    };
  }

  trace({ type: 'run_start', runId, model: config.model });
  const posture = config.posture ?? 'agent';
  emit?.({
    type: 'run.started',
    runId,
    threadId,
    mode: config.mode,
    posture,
    streaming: config.streaming,
    model: config.model,
    ...(config.estimatedPromptTokens !== undefined
      ? { estimatedPromptTokens: config.estimatedPromptTokens }
      : {}),
    ...(config.contextReport ? { contextReport: config.contextReport } : {}),
  });

  try {
    while (iterations < limits.maxIterations) {
      throwIfAborted(signal);
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

      const turn = await modelCall(
        config.model,
        messages,
        tools,
        onTextDelta,
        signal,
      );
      throwIfAborted(signal);

      trace({
        type: 'llm_response',
        runId,
        iteration: iterations,
        finishReason: turn.finishReason,
        hasToolCalls: Boolean(turn.toolCalls.length),
        contentPreview: turn.content ? preview(turn.content) : undefined,
      });

      if (turn.toolCalls.length > 0) {
        await appendDurable({
          role: 'assistant',
          content: turn.content || null,
          tool_calls: turn.toolCalls,
        });

        // Tool turns end like any other: the ledger row is durable, so the
        // client can settle this assistant message before tools run.
        emit?.({
          type: 'assistant.completed',
          runId,
          messageId,
          content: turn.content,
        });

        for (const [index, toolCall] of turn.toolCalls.entries()) {
          // The assistant tool_calls row above is already durable. On abort,
          // every remaining call still needs a tool row or ledger replay breaks.
          if (signal?.aborted) {
            await skipToolCalls(
              turn.toolCalls.slice(index),
              'Skipped: run cancelled.',
            );
            throwIfAborted(signal);
          }

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

            await skipToolCalls(
              turn.toolCalls.slice(index),
              'Skipped: tool call limit reached.',
            );

            return completeAfterLimit();
          }

          const toolName = toolCall.function.name;
          const tool = tools.byName.get(toolName);

          if (!tool) {
            await appendDurable({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Tool "${toolName}" does not exist.`,
            });
            continue;
          }

          if (posture === 'ask' && isAskStrippedTool(toolName)) {
            const blocked =
              'Blocked: this run is Ask (read-only). Switch the composer to Agent to edit files or run commands.';
            emit?.({
              type: 'tool.started',
              runId,
              toolCallId: toolCall.id,
              toolName,
              argsPreview: toolArgsPreview(toolName, {}),
            });
            emit?.({
              type: 'tool.completed',
              runId,
              toolCallId: toolCall.id,
              toolName,
              durationMs: 0,
              resultPreview: preview(blocked, 200),
            });
            await appendDurable({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: blocked,
            });
            continue;
          }

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            await appendDurable({
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

            await appendDurable({
              role: 'tool',
              tool_call_id: toolCall.id,
              content:
                'This exact tool call has already been attempted multiple times. Do not repeat it.',
            });

            await skipToolCalls(
              turn.toolCalls.slice(index + 1),
              'Skipped: tool call limit reached.',
            );

            return completeAfterLimit();
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
            argsPreview: toolArgsPreview(toolName, args),
          });

          const startedAt = Date.now();
          const toolCtx = buildToolContext();

          try {
            const result = await withTimeout(
              tool.execute(args, toolCtx),
              limits.toolTimeoutMs,
              signal,
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

            await appendDurable({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: result,
            });
          } catch (error) {
            if (signal?.aborted) {
              // Cancel mid-tool: the assistant tool_calls row is already durable,
              // so every unanswered call of this turn needs a tool row to keep
              // the ledger replay-valid.
              await skipToolCalls(
                turn.toolCalls.slice(index),
                'Skipped: run cancelled.',
              );
              throwIfAborted(signal);
            }

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

            await appendDurable({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Tool execution failed: ${errorMessage}`,
            });
          }
        }

        emitTurnCompleted(iterations, turn.usage);
        continue;
      }

      // No tool calls — this is the final assistant response.
      await appendDurable({
        role: 'assistant',
        content: turn.content ?? '',
      });

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
        emitTurnCompleted(iterations, turn.usage);
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
      emitTurnCompleted(iterations, turn.usage);
      emit?.({
        type: 'run.completed',
        runId,
        iterations,
        toolCalls: totalToolCalls,
        incomplete: true,
      });

      return {
        runId,
        content: turn.content ?? '',
        iterations,
        toolCalls: totalToolCalls,
        status: 'incomplete',
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

    return completeAfterLimit();
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

/**
 * Finalize the answer after a limit without offering tools.
 * The steering prompt joins the live `messages` array only — it is loop
 * control flow, not a durable turn, so it must never hit onMessage.
 */
async function finalizeWithoutTools(
  modelCall: ModelCallFn,
  model: string,
  messages: ChatCompletionMessageParam[],
  onTextDelta: ((delta: string) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<ModelTurn> {
  messages.push({
    role: 'user',
    content:
      'Tool budget reached. Answer my original question now using only the information above, and say what is uncertain.',
  });

  return modelCall(
    model,
    messages,
    {
      definitions: [],
      byName: new Map(),
    },
    onTextDelta,
    signal,
  );
}

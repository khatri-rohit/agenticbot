import { randomUUID } from 'node:crypto';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

import type { ToolRegistry } from '../tools/registry';
import { consoleTrace, type TraceEvent } from '../events/trace';
import { DEFAULT_LIMITS, type AgentLimits } from './limits';

/* ---------- public types ---------- */

/**
 * Result of one model call. Both streaming and non-streaming model functions
 * return this shape so the loop doesn't branch on transport.
 *
 * (Imported from @org/agent-models in Phase 4; kept local for Phase 2 to
 * avoid a circular type dependency while the model layer is still in flux.)
 */
export type ModelTurn = {
  content: string;
  toolCalls: ChatCompletionMessageToolCall[];
  finishReason: string | null;
};

/**
 * Function signature for a model call. The loop is transport-agnostic —
 * it calls this and consumes the ModelTurn. Phase 2 wires this to the
 * non-streaming invoke; Phase 3 adds a streaming implementation.
 */
export type ModelCallFn = (
  model: string,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
) => Promise<ModelTurn>;

export type RunLoopConfig = {
  runId?: string;
  model: string;
  limits?: Partial<AgentLimits>;
  trace?: (event: TraceEvent) => void;
};

export type RunLoopResult = {
  runId: string;
  content: string;
  iterations: number;
  toolCalls: number;
  status: 'completed' | 'error';
};

/* ---------- internal helpers (preserved from agent.ts) ---------- */

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
 * Enforces iteration, tool-call, and repeated-call limits with the same
 * semantics as the original runAgent.
 *
 * Host-agnostic: no HTTP, no DOM, no database. The model call is injected
 * so streaming vs non-streaming is a configuration concern, not a loop concern.
 */
export async function runLoop(
  modelCall: ModelCallFn,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  config: RunLoopConfig,
): Promise<RunLoopResult> {
  const limits = { ...DEFAULT_LIMITS, ...config.limits };
  const trace = config.trace ?? ((event: TraceEvent) => consoleTrace(event));
  const runId = config.runId ?? randomUUID();

  let iterations = 0;
  let totalToolCalls = 0;
  const repeatedCalls = new Map<string, number>();

  trace({ type: 'run_start', runId, model: config.model });

  try {
    while (iterations < limits.maxIterations) {
      iterations++;

      trace({ type: 'llm_request', runId, iteration: iterations });

      const turn = await modelCall(config.model, messages, tools);

      trace({
        type: 'llm_response',
        runId,
        iteration: iterations,
        finishReason: turn.finishReason,
        hasToolCalls: Boolean(turn.toolCalls.length),
        contentPreview: turn.content ? preview(turn.content) : undefined,
      });

      if (turn.toolCalls.length > 0) {
        // Preserve the assistant tool-call message in context.
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

            trace({
              type: 'run_finish',
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

            messages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: `Tool execution failed: ${errorMessage}`,
            });
          }
        }

        continue;
      }

      // No tool calls — this is the final assistant response.
      if (turn.finishReason === 'stop') {
        const result = turn.content ?? '';

        trace({
          type: 'run_finish',
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
 * When the tool budget is exhausted, ask the model to answer directly
 * from the information gathered so far. Uses the injected model call
 * so this works in both streaming and non-streaming modes.
 */
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
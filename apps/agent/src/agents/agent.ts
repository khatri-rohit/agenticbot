import { randomUUID } from 'node:crypto';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

import { client } from './model';
import { ToolRegistry } from './tools';
import { consoleTrace, type TraceEvent } from './trace';

const DEFAULT_LIMITS = {
  maxIterations: 8,
  maxToolCalls: 12,
  maxRepeatedToolCalls: 2,
  toolTimeoutMs: 30_000,
};

type AgentLimits = typeof DEFAULT_LIMITS;

type RunAgentOptions = {
  limits?: Partial<AgentLimits>;
  trace?: (event: TraceEvent) => void;
};

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
) {
  for (const toolCall of toolCalls) {
    messages.push({ role: 'tool', tool_call_id: toolCall.id, content: reason });
  }
}

async function finalizeWithoutTools(
  model: string,
  messages: ChatCompletionMessageParam[],
): Promise<string> {
  messages.push({
    role: 'user',
    content:
      'Tool budget reached. Answer my original question now using only the information above, and say what is uncertain.',
  });

  const response = await client.chat.completions.create({
    model,
    messages,
  });

  return response.choices[0]?.message.content ?? '';
}

export async function runAgent(
  model: string,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  options: RunAgentOptions = {},
): Promise<string> {
  const limits = {
    ...DEFAULT_LIMITS,
    ...options.limits,
  };

  const trace = options.trace ?? ((event: TraceEvent) => consoleTrace(event));

  const runId = randomUUID();

  let iterations = 0;
  let totalToolCalls = 0;

  const repeatedCalls = new Map<string, number>();

  trace({
    type: 'run_start',
    runId,
    model,
  });

  try {
    while (iterations < limits.maxIterations) {
      iterations++;

      trace({
        type: 'llm_request',
        runId,
        iteration: iterations,
      });

      const response = await client.chat.completions.create({
        model,
        messages,
        tools: tools.definitions,
      });

      const choice = response.choices[0];

      if (!choice) {
        throw new Error('Model returned no choices');
      }

      const message = choice.message;

      trace({
        type: 'llm_response',
        runId,
        iteration: iterations,
        finishReason: choice.finish_reason,
        hasToolCalls: Boolean(message.tool_calls?.length),
        contentPreview: message.content ? preview(message.content) : undefined,
      });

      if (message.tool_calls?.length) {
        messages.push(message);

        for (const [index, toolCall] of message.tool_calls.entries()) {
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
              message.tool_calls.slice(index),
              'Skipped: tool call limit reached.',
            );

            return finalizeWithoutTools(model, messages);
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
              message.tool_calls.slice(index + 1),
              'Skipped: tool call limit reached.',
            );

            return finalizeWithoutTools(model, messages);
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

      if (choice.finish_reason === 'stop') {
        const result = message.content ?? '';

        trace({
          type: 'run_finish',
          runId,
          iterations,
          toolCalls: totalToolCalls,
        });

        return result;
      }

      trace({
        type: 'limit',
        runId,
        iteration: iterations,
        reason: `unexpected finish reason: ${choice.finish_reason}`,
      });

      return message.content ?? '';
    }

    trace({
      type: 'limit',
      runId,
      iteration: iterations,
      reason: `max iterations exceeded (${limits.maxIterations})`,
    });

    return finalizeWithoutTools(model, messages);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    trace({
      type: 'tool_error',
      runId,
      iteration: iterations,
      toolName: 'agent',
      error: message,
    });

    return `Agent error: ${message}`;
  }
}

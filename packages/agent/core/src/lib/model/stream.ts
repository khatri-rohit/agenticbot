import { randomUUID } from 'node:crypto';
import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

import { client } from './client';
import type { ModelTurn } from '../loop/loop';
import type { ToolRegistry } from '../tools/type';

/**
 * Callback type for receiving streamed text deltas.
 */
export type OnTextDelta = (delta: string) => void;

/**
 * Internal accumulator for a tool call being reconstructed from stream chunks.
 */
type AccumulatedToolCall = {
  id: string;
  type: 'function';
  functionName: string;
  arguments: string;
};

/**
 * Streaming model call. Calls chat.completions.create with stream:true,
 * consumes the async iterable of chunks, accumulates text and tool-call
 * fragments, and returns the completed ModelTurn.
 *
 * Critical rules:
 * - Never execute a tool on a partial chunk. Wait for finish_reason.
 * - Tool-call arguments arrive fragmented across chunks; reconstruct by index.
 * - Some Ollama models drop the tool_call id on stream chunks — synthesize one.
 *
 * @param onTextDelta Called for each text fragment as it arrives.
 */
export async function streamModelTurn(
  model: string,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  onTextDelta?: OnTextDelta,
): Promise<ModelTurn> {
  const stream = await client.chat.completions.create({
    model,
    messages,
    tools: tools.definitions,
    stream: true,
  });

  let content = '';
  let finishReason: string | null = null;
  const toolCalls = new Map<number, AccumulatedToolCall>();

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (!choice) {
      continue;
    }

    const delta = choice.delta;

    // Text delta — emit immediately.
    if (delta.content) {
      content += delta.content;
      onTextDelta?.(delta.content);
    }

    // Tool-call deltas — accumulate by index.
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const index = tc.index;

        let existing = toolCalls.get(index);

        if (!existing) {
          // First chunk for this tool call.
          existing = {
            id: tc.id || randomUUID(),
            type: 'function',
            functionName: tc.function?.name ?? '',
            arguments: tc.function?.arguments ?? '',
          };
          toolCalls.set(index, existing);
          continue;
        }

        // Subsequent chunks — append fragments.
        if (tc.id) {
          existing.id = tc.id;
        }
        if (tc.function?.name) {
          existing.functionName += tc.function.name;
        }
        if (tc.function?.arguments) {
          existing.arguments += tc.function.arguments;
        }
      }
    }

    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
  }

  // Convert accumulated tool calls to the ChatCompletionMessageToolCall shape.
  const reconstructedToolCalls: ChatCompletionMessageToolCall[] = [];

  for (const acc of toolCalls.values()) {
    reconstructedToolCalls.push({
      id: acc.id,
      type: 'function',
      function: {
        name: acc.functionName,
        arguments: acc.arguments,
      },
    });
  }

  return {
    content,
    toolCalls: reconstructedToolCalls,
    finishReason,
  };
}

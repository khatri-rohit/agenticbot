import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';

import { client } from './client';
import type { ToolRegistry } from '../tools/registry';
import type { ModelTurn } from '../loop/loop';

/**
 * Non-streaming model call. Calls chat.completions.create with stream:false
 * and returns the complete ModelTurn.
 *
 * This is the Phase 2 model call — preserves the original agent.ts behavior
 * where the full response is awaited before processing tool calls.
 */
export async function invokeModelTurn(
  model: string,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  _onTextDelta?: (delta: string) => void,
): Promise<ModelTurn> {
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

  return {
    content: message.content ?? '',
    toolCalls: (message.tool_calls ?? []) as ChatCompletionMessageToolCall[],
    finishReason: choice.finish_reason,
  };
}

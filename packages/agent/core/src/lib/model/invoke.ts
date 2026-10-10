import type { PendingToolCall } from '@org/agent-models';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { client } from './client';
import type { ModelCallOptions } from './call-options';
import type { ModelTurn } from './types';
import type { ToolRegistry } from '../tools/type';

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
  options?: ModelCallOptions,
): Promise<ModelTurn> {
  // Ollama accepts reasoning_effort values beyond OpenAI's ReasoningEffort enum.
  const response = await client.chat.completions.create({
    model,
    messages,
    tools: tools.definitions,
    ...(options?.reasoningEffort !== undefined
      ? { reasoning_effort: options.reasoningEffort }
      : {}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  const choice = response.choices[0];

  if (!choice) {
    throw new Error('Model returned no choices');
  }

  const message = choice.message;

  return {
    content: message.content ?? '',
    toolCalls: (message.tool_calls ?? []) as PendingToolCall[],
    finishReason: choice.finish_reason,
  };
}

import type { PendingToolCall } from '@org/agent-models';
import type {
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';

import { getClient } from './client';
import type {
  ModelCallOptions,
  OllamaChatCompletionCreateParamsNonStreaming,
} from './call-options';
import { parseTokenUsage } from './parse-usage';
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
  const params: OllamaChatCompletionCreateParamsNonStreaming = {
    model,
    messages,
    tools: tools.definitions,
    ...(options?.reasoningEffort !== undefined
      ? { reasoning_effort: options.reasoningEffort }
      : {}),
  };

  // Ollama reasoning_effort is wider than OpenAI ReasoningEffort — cast at SDK boundary.
  const response = await getClient().chat.completions.create(
    params as ChatCompletionCreateParamsNonStreaming,
  );

  const choice = response.choices[0];

  if (!choice) {
    throw new Error('Model returned no choices');
  }

  const message = choice.message;
  const usage = parseTokenUsage(response.usage);

  return {
    content: message.content ?? '',
    toolCalls: (message.tool_calls ?? []) as PendingToolCall[],
    finishReason: choice.finish_reason,
    ...(usage ? { usage } : {}),
  };
}

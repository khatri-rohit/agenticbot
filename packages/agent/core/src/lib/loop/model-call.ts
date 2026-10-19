import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type { ModelCallFn } from './types';
import type { ModelCallOptions } from '../model/call-options';
import { streamModelTurn } from '../model/stream';
import type { ToolRegistry } from '../tools/type';

/**
 * Create a ModelCallFn over the streaming chat.completions path.
 * Wires the onTextDelta callback (provided by the loop at call time)
 * into streamModelTurn.
 */
export function createStreamModelCall(options?: ModelCallOptions): ModelCallFn {
  return (
    model: string,
    messages: ChatCompletionMessageParam[],
    tools: ToolRegistry,
    onTextDelta?: (delta: string) => void,
    signal?: AbortSignal,
  ): ReturnType<ModelCallFn> =>
    streamModelTurn(model, messages, tools, onTextDelta, {
      ...options,
      ...(signal ? { signal } : {}),
    });
}

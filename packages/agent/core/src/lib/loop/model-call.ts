import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type { ModelCallFn } from './types';
import type { ModelCallOptions } from '../model/call-options';
import { invokeModelTurn } from '../model/invoke';
import { streamModelTurn } from '../model/stream';
import type { ToolRegistry } from '../tools/type';

/**
 * Create a ModelCallFn for non-streaming mode.
 * Ignores the onTextDelta parameter (non-streaming has no deltas).
 */
export function createInvokeModelCall(
  options?: ModelCallOptions,
): ModelCallFn {
  return (
    model: string,
    messages: ChatCompletionMessageParam[],
    tools: ToolRegistry,
  ): ReturnType<ModelCallFn> =>
    invokeModelTurn(model, messages, tools, undefined, options);
}

/**
 * Create a ModelCallFn for streaming mode.
 * Wires the onTextDelta callback (provided by the loop at call time)
 * into streamModelTurn.
 */
export function createStreamModelCall(
  options?: ModelCallOptions,
): ModelCallFn {
  return (
    model: string,
    messages: ChatCompletionMessageParam[],
    tools: ToolRegistry,
    onTextDelta?: (delta: string) => void,
  ): ReturnType<ModelCallFn> =>
    streamModelTurn(model, messages, tools, onTextDelta, options);
}

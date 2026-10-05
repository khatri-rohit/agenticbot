import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type { ToolRegistry } from '../tools/registry';
import type { ModelCallFn } from './loop';
import { invokeModelTurn } from '../model/invoke';
import { streamModelTurn } from '../model/stream';

/**
 * Create a ModelCallFn for non-streaming mode.
 * Ignores the onTextDelta parameter (non-streaming has no deltas).
 */
export function createInvokeModelCall(): ModelCallFn {
  return (
    model: string,
    messages: ChatCompletionMessageParam[],
    tools: ToolRegistry,
  ): ReturnType<ModelCallFn> => invokeModelTurn(model, messages, tools);
}

/**
 * Create a ModelCallFn for streaming mode.
 * Wires the onTextDelta callback (provided by the loop at call time)
 * into streamModelTurn.
 */
export function createStreamModelCall(): ModelCallFn {
  return (
    model: string,
    messages: ChatCompletionMessageParam[],
    tools: ToolRegistry,
    onTextDelta?: (delta: string) => void,
  ): ReturnType<ModelCallFn> =>
    streamModelTurn(model, messages, tools, onTextDelta);
}
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type { ToolRegistry } from '../tools/registry';
import type { ModelCallFn, ModelTurn } from './loop';
import { invokeModelTurn } from '../model/invoke';
import { streamModelTurn, type OnTextDelta } from '../model/stream';

/**
 * Create a ModelCallFn for non-streaming mode.
 * The loop calls this function; it delegates to invokeModelTurn.
 */
export function createInvokeModelCall(): ModelCallFn {
  return invokeModelTurn;
}

/**
 * Create a ModelCallFn for streaming mode.
 * Captures the onTextDelta callback and wires it into streamModelTurn,
 * returning a function with the standard ModelCallFn signature.
 *
 * The loop doesn't know about streaming — it just calls the function.
 * The onTextDelta callback is where the event layer hooks in (Phase 4)
 * to emit assistant.delta events.
 */
export function createStreamModelCall(
  onTextDelta?: OnTextDelta,
): ModelCallFn {
  return (
    model: string,
    messages: ChatCompletionMessageParam[],
    tools: ToolRegistry,
  ): Promise<ModelTurn> => streamModelTurn(model, messages, tools, onTextDelta);
}
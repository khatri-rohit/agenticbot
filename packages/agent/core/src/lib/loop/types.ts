import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type { AgentEventWithoutSeq } from '@org/agent-models';
import type { TraceEvent } from '../events/trace-types';
import type { ModelTurn } from '../model/types';
import type { ToolRegistry } from '../tools/type';
import type { AgentLimits } from './limits';

/** Terminal status returned by runLoop (in-memory run summary, not persisted Run). */
export type RunLoopStatus = 'completed' | 'error';

/**
 * Transport-agnostic model invocation. The loop supplies onTextDelta so it can
 * wire assistant.delta events with a stable messageId.
 */
export type ModelCallFn = (
  model: string,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  onTextDelta?: (delta: string) => void,
) => Promise<ModelTurn>;

export type RunLoopConfig = {
  runId?: string;
  threadId?: string;
  model: string;
  streaming: boolean;
  limits?: Partial<AgentLimits>;
  /** Legacy trace callback (eval harness). Kept for backward compat. */
  trace?: (event: TraceEvent) => void;
  /** If provided, emits AgentEvents for SSE / UI consumers. */
  emit?: (event: AgentEventWithoutSeq) => void;
};

export type RunLoopResult = {
  runId: string;
  content: string;
  iterations: number;
  toolCalls: number;
  status: RunLoopStatus;
};

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type { EventEmitter } from '../events/emitter';
import type { AgentLimits } from '../loop/limits';
import type { ModelCallFn, RunLoopResult } from '../loop/types';
import type { ToolRegistry } from '../tools/type';

/** In-memory run handle status (RunManager; narrower than domain RunStatus). */
export type RunHandleStatus = 'running' | 'completed' | 'error';

export type RunHandle = {
  runId: string;
  threadId: string;
  status: RunHandleStatus;
  cancelled: boolean;
  emitter: EventEmitter;
  result: RunLoopResult | null;
};

export type StartRunOptions = {
  threadId: string;
  model: string;
  streaming: boolean;
  messages: ChatCompletionMessageParam[];
  tools: ToolRegistry;
  modelCall: ModelCallFn;
  limits?: AgentLimits;
};

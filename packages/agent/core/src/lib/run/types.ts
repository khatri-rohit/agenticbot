import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type {
  ContextReport,
  LedgerRecord,
  RunPosture,
  ToolOrigin,
} from '@org/agent-models';

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
  abortController: AbortController;
  emitter: EventEmitter;
  result: RunLoopResult | null;
};

export type StartRunOptions = {
  threadId: string;
  model: string;
  streaming: boolean;
  /** Mode name for run.started (e.g. HOME_MODE.name). */
  mode: string;
  posture?: RunPosture;
  messages: ChatCompletionMessageParam[];
  tools: ToolRegistry;
  modelCall: ModelCallFn;
  limits?: AgentLimits;
  /** Heuristic size of the first request envelope (system + tools + messages). */
  estimatedPromptTokens?: number;
  contextReport?: ContextReport;
  origin?: ToolOrigin;
  workspaceRoot?: string;
  /** Host persistence seam (ledger append in M1). */
  onMessage?: (record: LedgerRecord) => void | Promise<void>;
  /** After the loop returns (success or error). Used for M4 compaction. */
  onFinished?: (result: RunLoopResult) => void | Promise<void>;
};

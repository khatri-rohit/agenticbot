import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type {
  ChoiceOption,
  ChoiceResult,
  ContextBudget,
  ContextReport,
  LedgerAppendMeta,
  LedgerRecord,
  RunPosture,
  SubagentSpec,
  SubagentResult,
  ToolOrigin,
  TraceEvent,
} from '@agent/agent-models';

import type { EventEmitter } from '../events/emitter';
import type { AgentLimits } from '../loop/limits';
import type { ModelCallFn, RunLoopResult } from '../loop/types';
import type { ToolRegistry } from '../tools/type';

/** In-memory run handle status (RunManager; narrower than domain RunStatus). */
export type RunHandleStatus = 'running' | 'completed' | 'error';

export type PendingChoiceWaiter = {
  options: ChoiceOption[];
  resolve: (result: ChoiceResult) => void;
  reject: (error: Error) => void;
};

export type ResolveChoiceResult = 'ok' | 'not_found' | 'invalid';

export type RunHandle = {
  runId: string;
  threadId: string;
  status: RunHandleStatus;
  cancelled: boolean;
  abortController: AbortController;
  emitter: EventEmitter;
  result: RunLoopResult | null;
  pendingChoices: Map<string, PendingChoiceWaiter>;
  /** Posture: ask runs are read-only. */
  posture?: RunPosture;
};

export type StartRunOptions = {
  threadId: string;
  model: string;
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
  putBlob?: (text: string) => Promise<string>;
  readBlob?: (
    sha256: string,
    offset?: number,
    length?: number,
  ) => Promise<string>;
  /** Host persistence seam (ledger append in M1). */
  onMessage?: (record: LedgerRecord, meta?: LedgerAppendMeta) => void | Promise<void>;
  /** After the loop returns (success or error). Used for M4 compaction. */
  onFinished?: (result: RunLoopResult) => void | Promise<void>;
  hasOpenPlanWork?: () => boolean | Promise<boolean>;
  contextBudget?: ContextBudget;
  /** Trace sink for offline replay / eval debugging. Optional. */
  trace?: (event: TraceEvent) => void;
  /** Spawn a sub-agent (recursive runLoop on a child thread). Host-injected. */
  spawnSubagent?: (spec: SubagentSpec) => Promise<SubagentResult>;
  /** Sub-agent recursion depth (parent run = 0). */
  subagentDepth?: number;
};

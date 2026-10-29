import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type {
  ChoiceOption,
  ChoiceResult,
  ContextBudget,
  ContextReport,
  LedgerAppendMeta,
  LedgerRecord,
  RunPosture,
  ToolOrigin,
  TraceEvent,
} from '@agent/agent-models';

import type { EventEmitter } from '../events/emitter';
import type { AgentLimits } from '../loop/limits';
import type {
  ModelCallFn,
  RunLoopResult,
  SubagentSpawner,
} from '../loop/types';
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
  /** Settles with the result after onFinished. */
  done: Promise<RunLoopResult>;
};

export type StartRunOptions = {
  /** Fixed id (sub-agents use the id they announced in subrun.started). */
  runId?: string;
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
  /** Sub-agent runner; the loop binds it to this run. */
  subagents?: SubagentSpawner;
  /** 0 for a user run, 1 for a sub-agent. */
  depth?: number;
  parentRunId?: string;
  /** Parent run's signal: aborting it cancels this run. */
  parentSignal?: AbortSignal;
};

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type {
  ApprovalOption,
  ApprovalResult,
  ChoiceOption,
  ChoiceResult,
  ContextBudget,
  ContextReport,
  LedgerAppendMeta,
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

export type PendingApprovalWaiter = {
  toolName: string;
  options?: ApprovalOption[];
  resolve: (result: ApprovalResult) => void;
  reject: (error: Error) => void;
};

export type ResolveApprovalResult = 'ok' | 'not_found' | 'invalid_option';

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
  pendingApprovals: Map<string, PendingApprovalWaiter>;
  pendingChoices: Map<string, PendingChoiceWaiter>;
  grantedTools: Set<string>;
  /** Workspace root for mutex enforcement (coding runs only). */
  workspaceRoot?: string;
  /** Posture: ask runs are read-only and don't need the workspace mutex. */
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
};

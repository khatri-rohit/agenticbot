import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type {
  AgentEventWithoutSeq,
  ApprovalRequest,
  ApprovalResult,
  ChoiceRequest,
  ChoiceResult,
  ContextBudget,
  ContextReport,
  LedgerAppendMeta,
  LedgerRecord,
  RunPosture,
  ToolOrigin,
} from '@agent/agent-models';
import type { TraceEvent } from '../events/trace-types';
import type { ModelTurn } from '../model/types';
import type { ToolRegistry } from '../tools/type';
import type { AgentLimits } from './limits';

/** Terminal status returned by runLoop (in-memory run summary, not persisted Run). */
export type RunLoopStatus = 'completed' | 'error' | 'incomplete';

/**
 * Transport-agnostic model invocation. The loop supplies onTextDelta so it can
 * wire assistant.delta events with a stable messageId.
 * `signal` aborts in-flight provider work when the run is cancelled.
 */
export type ModelCallFn = (
  model: string,
  messages: ChatCompletionMessageParam[],
  tools: ToolRegistry,
  onTextDelta?: (delta: string) => void,
  signal?: AbortSignal,
) => Promise<ModelTurn>;

export type RunLoopConfig = {
  runId?: string;
  threadId?: string;
  model: string;
  /** Mode name for run.started (e.g. HOME_MODE.name). */
  mode: string;
  /** Host-applied Ask | Agent. Loop refuses write/exec when ask. */
  posture?: RunPosture;
  limits?: Partial<AgentLimits>;
  /** Heuristic size of the first request envelope (system + tools + messages). */
  estimatedPromptTokens?: number;
  /** Per-layer breakdown from assembleContext. */
  contextReport?: ContextReport;
  /** Aborted when RunManager.cancel runs. */
  signal?: AbortSignal;
  /** Origin for ToolContext (default chat). */
  origin?: ToolOrigin;
  /** Bound workspace for file tools. */
  workspaceRoot?: string;
  /** Host blob store for full web pages (optional; loop keeps an in-run cache). */
  putBlob?: (text: string) => Promise<string>;
  readBlob?: (
    sha256: string,
    offset?: number,
    length?: number,
  ) => Promise<string>;
  /**
   * ask_user pause seam. Chat wires RunManager; CLI/eval may auto-resolve.
   * The wait must not sit inside toolTimeoutMs.
   */
  approve?: (request: ApprovalRequest) => Promise<ApprovalResult>;
  /** Mid-turn direction picker. Skip must stop the run, not invent a path. */
  offerChoice?: (request: ChoiceRequest) => Promise<ChoiceResult>;
  /** Legacy trace callback (eval harness). Kept for backward compat. */
  trace?: (event: TraceEvent) => void;
  /** If provided, emits AgentEvents for SSE / UI consumers. */
  emit?: (event: AgentEventWithoutSeq) => void;
  /**
   * Host persistence seam: called when the loop appends a durable turn.
   * Not used for SSE preview deltas. Host owns append (ledger in M1).
   */
  onMessage?: (record: LedgerRecord, meta?: LedgerAppendMeta) => void | Promise<void>;
  /**
   * Host reads the live plan. When a Final plan still has open todos,
   * the loop nudges once, then finishes incomplete instead of a clean stop.
   */
  hasOpenPlanWork?: () => boolean | Promise<boolean>;
  /** Budget for mid-turn tool-result stubbing. Defaults to DEFAULT_CONTEXT_BUDGET. */
  contextBudget?: ContextBudget;
};

export type RunLoopResult = {
  runId: string;
  content: string;
  iterations: number;
  toolCalls: number;
  status: RunLoopStatus;
};

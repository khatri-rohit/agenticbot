import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type {
  AgentEventWithoutSeq,
  ContextReport,
  LedgerRecord,
  ToolOrigin,
} from '@org/agent-models';
import type { TraceEvent } from '../events/trace-types';
import type { ModelTurn } from '../model/types';
import type { ToolRegistry } from '../tools/type';
import type { AgentLimits } from './limits';

/** Terminal status returned by runLoop (in-memory run summary, not persisted Run). */
export type RunLoopStatus = 'completed' | 'error';

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
  streaming: boolean;
  /** Mode name for run.started (e.g. HOME_MODE.name). */
  mode: string;
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
  /** Legacy trace callback (eval harness). Kept for backward compat. */
  trace?: (event: TraceEvent) => void;
  /** If provided, emits AgentEvents for SSE / UI consumers. */
  emit?: (event: AgentEventWithoutSeq) => void;
  /**
   * Host persistence seam: called when the loop appends a durable turn.
   * Not used for SSE preview deltas. Host owns append (ledger in M1).
   */
  onMessage?: (record: LedgerRecord) => void | Promise<void>;
};

export type RunLoopResult = {
  runId: string;
  content: string;
  iterations: number;
  toolCalls: number;
  status: RunLoopStatus;
};

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type {
  AgentEventWithoutSeq,
  ChoiceRequest,
  ChoiceResult,
  ContextBudget,
  ContextReport,
  LedgerAppendMeta,
  LedgerRecord,
  RunPosture,
  RunUsage,
  SubagentSpec,
  SubagentResult,
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

/**
 * Account capacity, supplied by the host (e.g. the Ollama session/weekly
 * balance). Every method is synchronous and reads host-cached state, so the
 * loop never waits on the network. Omitted = capacity is never a gate.
 */
export type CapacityGate = {
  /** Checked before each model call. A reason pauses the run (no final call). */
  pauseReason(): string | null;
  /** While true, progress steering uses tighter marks. */
  conserve(): boolean;
  /** A model-call error that means "usage limit reached" → pause reason; else null. */
  limitReasonFor(error: unknown): string | null;
};

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
  /**
   * Sub-agent runner. The loop binds it to this run (signal, budget,
   * capabilities) when the registry has `delegate`.
   */
  subagents?: SubagentSpawner;
  /** 0 for a user run, 1 for a sub-agent. */
  depth?: number;
  /** Set on sub-agent runs, for traces. */
  parentRunId?: string;
  /** The user's `/` picks for this send (already in the prompt as Loaded skills). */
  pinnedSkills?: string[];
  /** Account capacity gate; children share the parent's. */
  capacity?: CapacityGate;
};

/** What a sub-agent inherits from (and reports back to) its parent run. */
export type SubagentParent = {
  runId: string;
  threadId: string;
  model: string;
  depth: number;
  posture: RunPosture;
  signal: AbortSignal;
  workspaceRoot?: string;
  /** Parent registry names; a child's tools are a subset. */
  toolNames: string[];
  contextBudget: ContextBudget;
  /** Parent's unspent prompt-token budget, when capped. */
  remainingPromptTokens?: number;
  /** Parent conversation for an advisor fork. */
  forkMessages: () => ChatCompletionMessageParam[];
  /** Parent stream, for subrun.* markers. */
  emit?: (event: AgentEventWithoutSeq) => void;
  /** The user's `/` picks for this send; profiles may inherit them. */
  pinnedSkills?: string[];
  /** Roll the child's spend into the parent's usage and budget. */
  chargeUsage: (usage: RunUsage) => void;
  /** The parent's capacity gate; a child pauses on the same account limits. */
  capacity?: CapacityGate;
};

export type SubagentSpawner = (
  spec: SubagentSpec,
  parent: SubagentParent,
) => Promise<SubagentResult>;

export type RunLoopResult = {
  runId: string;
  content: string;
  iterations: number;
  toolCalls: number;
  status: RunLoopStatus;
  /** Present when status is incomplete due to a loop gate. */
  limitReason?: string;
  /** Token spend, own + sub-agents. */
  usage: RunUsage;
};

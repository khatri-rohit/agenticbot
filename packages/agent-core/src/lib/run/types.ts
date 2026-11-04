import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type {
  ContextBudget,
  ContextReport,
  LedgerAppendMeta,
  LedgerRecord,
  RunOutcome,
  RunPosture,
  ToolOrigin,
  TraceEvent,
} from '@agent/agent-models';

import type { AgentLimits } from '../loop/limits';
import type {
  CapacityGate,
  ModelCallFn,
  RunLoopResult,
  SubagentSpawner,
} from '../loop/types';
import type { EffortPolicy } from '../system1/effort';
import type { System1Port } from '../system1/port';
import type { ToolRegistry } from '../tools/types';

export type ResolveChoiceResult = 'ok' | 'not_found' | 'invalid';

/** cancelled: stopping now · finishing: the loop is done, post-run work only. */
export type CancelResult = 'cancelled' | 'finishing' | 'not_found';

/** What `wait` resolves with once a run has settled (after onFinished). */
export type RunEnd = { result: RunLoopResult; outcome: RunOutcome };

/**
 * A thread held for one run. The holder sets the run up, then starts it, or
 * releases the thread if setup fails.
 */
export type RunClaim = {
  runId: string;
  /**
   * Waits for a cancelled or finishing run on the same thread to settle.
   * False when it did not settle in time: release and report busy.
   */
  ready: Promise<boolean>;
  start(opts: StartRunOptions): void;
  release(): void;
};

export type ClaimResult =
  | { ok: true; claim: RunClaim }
  | { ok: false; activeRunId: string };

export type StartRunOptions = {
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
  /** Host persistence seam (ledger append). */
  onMessage?: (record: LedgerRecord, meta?: LedgerAppendMeta) => void | Promise<void>;
  /** After the loop returns, before the run settles. Its events still stream. */
  onFinished?: (result: RunLoopResult, outcome: RunOutcome) => void | Promise<void>;
  hasOpenPlanWork?: () => boolean | Promise<boolean>;
  contextBudget?: ContextBudget;
  /** Trace sink for offline replay / eval debugging. Optional. */
  trace?: (event: TraceEvent) => void;
  /** Account capacity gate (host-cached balance). Optional. */
  capacity?: CapacityGate;
  /** Sub-agent runner; the loop binds it to this run. */
  subagents?: SubagentSpawner;
  /** 0 for a user run, 1 for a sub-agent. */
  depth?: number;
  parentRunId?: string;
  /** The user's `/` picks for this send. */
  pinnedSkills?: string[];
  /** Parent run's signal: aborting it cancels this run. */
  parentSignal?: AbortSignal;
  /** Optional System 1 scorer (see RunLoopConfig.system1). */
  system1?: System1Port;
  /** Thinking choices for this run (see RunLoopConfig.effortPolicy). */
  effortPolicy?: EffortPolicy;
  /** How long the settled run's events stay for late subscribers. Default RUN_HANDLE_TTL_MS. */
  retainMs?: number;
};

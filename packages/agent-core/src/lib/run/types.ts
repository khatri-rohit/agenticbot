import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type { RunOutcome } from '@agent/agent-models';

import type { ModelCallFn, RunLoopConfig, RunLoopResult } from '../loop/types';
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
  start(opts: StartRunOptions, hooks?: RunHooks): void;
  release(): void;
};

export type ClaimResult =
  | { ok: true; claim: RunClaim }
  | { ok: false; activeRunId: string };

/**
 * What a host sets for a run: the loop's own config, minus what the manager
 * owns (identity, abort signal, events, choices). A new loop option needs no
 * change here.
 */
export type StartRunOptions = Omit<
  RunLoopConfig,
  'runId' | 'threadId' | 'signal' | 'emit' | 'offerChoice'
> & {
  messages: ChatCompletionMessageParam[];
  tools: ToolRegistry;
  modelCall: ModelCallFn;
};

/** The run's lifecycle around the loop (not loop config). */
export type RunHooks = {
  /** After the loop returns, before the run settles. Its events still stream. */
  onFinished?: (result: RunLoopResult, outcome: RunOutcome) => void | Promise<void>;
  /** Parent run's signal: aborting it cancels this run. */
  parentSignal?: AbortSignal;
  /** How long the settled run's events stay for late subscribers. Default RUN_HANDLE_TTL_MS. */
  retainMs?: number;
};

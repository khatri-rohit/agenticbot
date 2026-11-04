import { randomUUID } from 'node:crypto';

import {
  ChoiceSkipped,
  emptyRunUsage,
  MAX_CHOICE_TEXT_CHARS,
  RUN_CANCELLED_REASON,
  type ActiveRun,
  type AgentEvent,
  type AgentEventWithoutSeq,
  type ChoiceRequest,
  type ChoiceResult,
  type RunPosture,
} from '@agent/agent-models';
import { runLoop } from '../loop/loop';
import type { RunLoopResult } from '../loop/types';
import { EventEmitter } from '../events/emitter';
import type { EventSubscriber } from '../events/types';
import type {
  CancelResult,
  ClaimResult,
  ResolveChoiceResult,
  RunEnd,
  RunHooks,
  StartRunOptions,
} from './types';

/** How long a settled run's events stay for late SSE subscribers; then 404, and the ledger is the truth. */
const RUN_HANDLE_TTL_MS = 5 * 60_000;

/** How long a new run waits for a cancelled or finishing run on its thread to settle. */
const PREDECESSOR_WAIT_MS = 10_000;

/**
 * claimed: setting up · running: the loop · finishing: onFinished (last run,
 * compaction) · settled: done, events kept for late subscribers.
 */
type RunPhase = 'claimed' | 'running' | 'finishing' | 'settled';

type PendingChoice = ChoiceRequest & {
  resolve: (result: ChoiceResult) => void;
  reject: (error: Error) => void;
};

type RunHandle = {
  runId: string;
  threadId: string;
  phase: RunPhase;
  cancelled: boolean;
  abortController: AbortController;
  emitter: EventEmitter;
  pendingChoices: Map<string, PendingChoice>;
  model?: string;
  posture: RunPosture;
  startedAt?: string;
  done: Promise<RunEnd>;
  settle: (end: RunEnd) => void;
};

function emptyResult(runId: string, content = ''): RunLoopResult {
  return {
    runId,
    content,
    iterations: 0,
    toolCalls: 0,
    status: 'error',
    usage: emptyRunUsage(),
  };
}

/**
 * Owns every run's lifecycle in this process: one run per thread (claimed
 * synchronously, so two sends cannot both start), one gate for events, one
 * outcome, cancel, and cleanup. Hosts set a run up between `claim` and
 * `start`, and send their own events through `publish`.
 */
export class RunManager {
  private runs = new Map<string, RunHandle>();

  /**
   * Hold `threadId` for a new run. Busy while another run on it is being set
   * up or is running; a cancelled or finishing run is waited for instead
   * (`claim.ready`), because its last writes (lastRun, child threads) must not
   * race the next run's rewind.
   */
  claim(threadId: string, runId: string = randomUUID()): ClaimResult {
    const others = [...this.runs.values()].filter(
      (handle) => handle.threadId === threadId && handle.phase !== 'settled',
    );
    const blocking = others.find(
      (handle) =>
        handle.phase === 'claimed' ||
        (handle.phase === 'running' && !handle.cancelled),
    );
    if (blocking) return { ok: false, activeRunId: blocking.runId };

    let settle!: (end: RunEnd) => void;
    const handle: RunHandle = {
      runId,
      threadId,
      phase: 'claimed',
      cancelled: false,
      abortController: new AbortController(),
      emitter: new EventEmitter(),
      pendingChoices: new Map(),
      posture: 'agent',
      done: new Promise<RunEnd>((resolve) => {
        settle = resolve;
      }),
      settle: (end) => settle(end),
    };
    this.runs.set(runId, handle);

    return {
      ok: true,
      claim: {
        runId,
        ready: waitForAll(others.map((other) => other.done)),
        start: (opts, hooks = {}) => this.start(handle, opts, hooks),
        release: () => {
          if (handle.phase !== 'claimed') return;
          this.finish(handle, { result: emptyResult(runId), outcome: 'error' }, 0);
        },
      },
    };
  }

  private start(handle: RunHandle, opts: StartRunOptions, hooks: RunHooks): void {
    if (handle.phase !== 'claimed') return;
    handle.phase = 'running';
    handle.model = opts.model;
    handle.posture = opts.posture ?? 'agent';
    handle.startedAt = new Date().toISOString();

    // A child run dies with its parent: parent cancel aborts this run too.
    const { parentSignal } = hooks;
    const onParentAbort = () => this.cancel(handle.runId);
    if (parentSignal?.aborted) queueMicrotask(onParentAbort);
    else parentSignal?.addEventListener('abort', onParentAbort, { once: true });

    void this.execute(handle, opts, hooks).finally(() =>
      parentSignal?.removeEventListener('abort', onParentAbort),
    );
  }

  private async loop(handle: RunHandle, opts: StartRunOptions): Promise<RunLoopResult> {
    const { messages, tools, modelCall, ...config } = opts;
    try {
      return await runLoop(modelCall, messages, tools, {
        ...config,
        runId: handle.runId,
        threadId: handle.threadId,
        posture: handle.posture,
        signal: handle.abortController.signal,
        // offer_choice pause; write/exec tools do not go through this hook.
        offerChoice: (request) => this.requestChoice(handle, request),
        emit: (event) => this.gate(handle, event),
      });
    } catch (err) {
      return emptyResult(
        handle.runId,
        `Run manager error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async execute(
    handle: RunHandle,
    opts: StartRunOptions,
    hooks: RunHooks,
  ): Promise<void> {
    const { runId } = handle;
    // Cancelled while it was being set up: skip the loop, still finish (lastRun).
    const result = handle.cancelled
      ? emptyResult(runId)
      : await this.loop(handle, opts);

    // Still live through onFinished so compaction events reach subscribers.
    handle.phase = 'finishing';
    const outcome = handle.cancelled ? 'cancelled' : result.status;
    try {
      await hooks.onFinished?.(result, outcome);
    } catch (error) {
      // Post-run work must not flip a finished run into an error.
      console.error(
        'onFinished failed (run outcome unchanged):',
        error instanceof Error ? error.message : error,
      );
    }
    handle.emitter.emit({
      type: 'run.settled',
      runId,
      ...(handle.cancelled
        ? { cancelled: true }
        : result.status === 'incomplete'
          ? { incomplete: true }
          : {}),
    });
    this.finish(handle, { result, outcome }, hooks.retainMs);
  }

  private finish(handle: RunHandle, end: RunEnd, retainMs = RUN_HANDLE_TTL_MS): void {
    handle.phase = 'settled';
    handle.settle(end);
    const timer = setTimeout(() => this.clear(handle.runId), retainMs);
    timer.unref?.();
  }

  /** The one gate for a run's events: nothing after a cancel except a child's settle card. */
  private gate(handle: RunHandle, event: AgentEventWithoutSeq): void {
    if (handle.phase === 'settled') return;
    if (handle.cancelled && event.type !== 'subrun.settled') return;
    handle.emitter.emit(event);
  }

  /** Host events (plan, memory, compaction) for a run, through the same gate. */
  publish(runId: string, event: AgentEventWithoutSeq): void {
    const handle = this.runs.get(runId);
    if (handle) this.gate(handle, event);
  }

  /** Resolves once the run has settled (after onFinished). Never rejects. */
  wait(runId: string): Promise<RunEnd> {
    const handle = this.runs.get(runId);
    if (!handle) return Promise.reject(new Error(`Run not found: ${runId}`));
    return handle.done;
  }

  private requestChoice(
    handle: RunHandle,
    request: ChoiceRequest,
  ): Promise<ChoiceResult> {
    if (handle.phase !== 'running' || handle.cancelled) {
      return Promise.reject(new Error(RUN_CANCELLED_REASON));
    }

    const choiceId = randomUUID();
    const signal = handle.abortController.signal;

    handle.emitter.emit({
      type: 'choice.requested',
      runId: handle.runId,
      choiceId,
      question: request.question,
      options: request.options,
    });

    return new Promise<ChoiceResult>((resolve, reject) => {
      const onAbort = () => {
        handle.pendingChoices.delete(choiceId);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error(RUN_CANCELLED_REASON),
        );
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });
      handle.pendingChoices.set(choiceId, {
        question: request.question,
        options: request.options,
        resolve: (result) => {
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
        reject: (error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      });
    });
  }

  resolveChoice(
    runId: string,
    choiceId: string,
    body:
      | { skipped: true }
      | { skipped?: false; optionIds: string[]; text?: string },
  ): ResolveChoiceResult {
    const handle = this.runs.get(runId);
    if (!handle || handle.phase !== 'running' || handle.cancelled) {
      return 'not_found';
    }
    const pending = handle.pendingChoices.get(choiceId);
    if (!pending) return 'not_found';

    if (body.skipped === true) {
      handle.pendingChoices.delete(choiceId);
      handle.emitter.emit({
        type: 'choice.resolved',
        runId,
        choiceId,
        skipped: true,
      });
      pending.reject(new ChoiceSkipped());
      return 'ok';
    }

    const allowed = new Set(pending.options.map((option) => option.id));
    const optionIds: string[] = [];
    const seen = new Set<string>();
    for (const id of body.optionIds) {
      if (!allowed.has(id)) return 'invalid';
      if (seen.has(id)) continue;
      seen.add(id);
      optionIds.push(id);
    }
    const text = body.text?.trim() || undefined;
    if (text && text.length > MAX_CHOICE_TEXT_CHARS) {
      return 'invalid';
    }
    if (optionIds.length === 0 && !text) {
      return 'invalid';
    }

    handle.pendingChoices.delete(choiceId);
    handle.emitter.emit({
      type: 'choice.resolved',
      runId,
      choiceId,
      skipped: false,
      ...(optionIds.length > 0 ? { optionIds } : {}),
      ...(text ? { text } : {}),
    });
    pending.resolve({ optionIds, ...(text ? { text } : {}) });
    return 'ok';
  }

  /**
   * The thread's run in progress (running or finishing, not cancelled), so a
   * reloaded client can show it and answer its choices.
   */
  activeRun(threadId: string): ActiveRun | undefined {
    for (const handle of this.runs.values()) {
      if (
        handle.threadId !== threadId ||
        handle.cancelled ||
        (handle.phase !== 'running' && handle.phase !== 'finishing')
      ) {
        continue;
      }
      return {
        runId: handle.runId,
        model: handle.model ?? '',
        posture: handle.posture,
        startedAt: handle.startedAt ?? '',
        pendingChoices: [...handle.pendingChoices].map(([choiceId, choice]) => ({
          choiceId,
          question: choice.question,
          options: choice.options,
        })),
      };
    }
    return undefined;
  }

  /** Not settled yet: a lastRun written for it is still the start marker. */
  isActive(runId: string): boolean {
    const handle = this.runs.get(runId);
    return handle !== undefined && handle.phase !== 'settled';
  }

  /**
   * Stop a run. While it is being set up or running: abort in-flight model and
   * tool work, and end its stream. Once the loop is done the answer is
   * already saved, so a late cancel changes nothing.
   */
  cancel(runId: string): CancelResult {
    const handle = this.runs.get(runId);
    if (!handle || handle.phase === 'settled') return 'not_found';
    if (handle.phase === 'finishing') return 'finishing';
    if (handle.cancelled) return 'cancelled';

    handle.cancelled = true;
    handle.abortController.abort(new Error(RUN_CANCELLED_REASON));
    handle.emitter.emit({
      type: 'run.error',
      runId,
      error: RUN_CANCELLED_REASON,
      cancelled: true,
    });
    return 'cancelled';
  }

  /**
   * Buffered events after `fromSeq`, plus a live subscription until the run
   * settles. Null when the run is unknown (never existed, or cleared).
   */
  subscribe(
    runId: string,
    fromSeq: number,
    subscriber: EventSubscriber,
  ): { replay: AgentEvent[]; live: boolean; unsubscribe: () => void } | null {
    const handle = this.runs.get(runId);
    if (!handle) return null;
    const replay = handle.emitter.getEventsFromSeq(fromSeq);
    if (handle.phase === 'settled') {
      return { replay, live: false, unsubscribe: () => undefined };
    }
    return { replay, live: true, unsubscribe: handle.emitter.subscribe(subscriber) };
  }

  private clear(runId: string): void {
    this.runs.get(runId)?.emitter.dispose();
    this.runs.delete(runId);
  }
}

/** True once every run has settled; false if any is still going after the wait. */
async function waitForAll(done: Promise<RunEnd>[]): Promise<boolean> {
  if (done.length === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), PREDECESSOR_WAIT_MS);
    timer.unref?.();
  });
  const settled = await Promise.race([
    Promise.all(done).then(() => true as const),
    timeout,
  ]);
  clearTimeout(timer);
  return settled;
}

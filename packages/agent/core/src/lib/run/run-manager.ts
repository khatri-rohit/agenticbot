import { randomUUID } from 'node:crypto';

import {
  ApprovalDenied,
  ChoiceSkipped,
  MAX_CHOICE_TEXT_CHARS,
  type AgentEvent,
  type ApprovalDecision,
  type ApprovalRequest,
  type ApprovalResult,
  type ChoiceRequest,
  type ChoiceResult,
} from '@org/agent-models';
import { runLoop } from '../loop/loop';
import { EventEmitter } from '../events/emitter';
import type { EventSubscriber } from '../events/types';
import type {
  ResolveApprovalResult,
  ResolveChoiceResult,
  RunHandle,
  StartRunOptions,
} from './types';

export type {
  ResolveApprovalResult,
  ResolveChoiceResult,
  RunHandle,
  RunHandleStatus,
  StartRunOptions,
} from './types';

/**
 * In-memory run manager. Holds live run state and event emitters.
 *
 * One active run per thread (enforced by the caller — the API layer).
 * When a run completes, its handle stays until explicitly cleared
 * (so late SSE subscribers can still replay).
 * cancel() aborts the run's AbortSignal so in-flight model/tool work stops.
 */
export class RunManager {
  private runs = new Map<string, RunHandle>();

  /** Start a run. Returns the runId immediately; the run executes async. */
  start(opts: StartRunOptions): string {
    const runId = randomUUID();
    const emitter = new EventEmitter();
    const abortController = new AbortController();

    const handle: RunHandle = {
      runId,
      threadId: opts.threadId,
      status: 'running',
      cancelled: false,
      abortController,
      emitter,
      result: null,
      pendingApprovals: new Map(),
      pendingChoices: new Map(),
      grantedTools: new Set(),
    };

    this.runs.set(runId, handle);

    // Execute async — don't block the caller.
    this.executeRun(runId, opts).catch((err) => {
      handle.status = 'error';
      handle.result = {
        runId,
        content: `Run manager error: ${err instanceof Error ? err.message : String(err)}`,
        iterations: 0,
        toolCalls: 0,
        status: 'error',
      };
    });

    return runId;
  }

  private async executeRun(
    runId: string,
    opts: StartRunOptions,
  ): Promise<void> {
    const handle = this.runs.get(runId);
    if (!handle) return;

    const result = await runLoop(opts.modelCall, opts.messages, opts.tools, {
      runId,
      threadId: opts.threadId,
      model: opts.model,
      mode: opts.mode,
      posture: opts.posture ?? 'agent',
      limits: opts.limits,
      estimatedPromptTokens: opts.estimatedPromptTokens,
      contextReport: opts.contextReport,
      signal: handle.abortController.signal,
      origin: opts.origin,
      workspaceRoot: opts.workspaceRoot,
      /*
       * IMPORTANT: Allow/Deny exec-approval wire. Temporarily commented so
       * file and command tools run without a pause, as they did before this
       * card. Do not delete this line — it must stay in the tree, commented,
       * until the Allow/Deny system is restored.
       *
       * approve: (request) => this.requestApproval(runId, request),
       */
      offerChoice: (request) => this.requestChoice(runId, request),
      onMessage: opts.onMessage,
      hasOpenPlanWork: opts.hasOpenPlanWork,
      contextBudget: opts.contextBudget,
      emit: (event) => {
        if (handle.cancelled) return;
        handle.emitter.emit(event);
      },
    });

    // Keep status 'running' through onFinished so compaction SSE reaches
    // live subscribers, then emit run.settled so the UI can leave the turn.
    handle.result = result;
    try {
      await opts.onFinished?.(result);
    } catch (error) {
      // Compaction must not flip a successful run into an error.
      console.error(
        'onFinished failed (run status unchanged):',
        error instanceof Error ? error.message : error,
      );
    }
    handle.status =
      handle.cancelled || result.status === 'error' ? 'error' : 'completed';
    if (!handle.cancelled) {
      handle.emitter.emit({
        type: 'run.settled',
        runId,
      });
    }
  }

  /**
   * Pause until the client resolves this request. Session grants skip the
   * wait for the same tool name on later calls in this run (not ask_user).
   */
  requestApproval(
    runId: string,
    request: ApprovalRequest,
  ): Promise<ApprovalResult> {
    const handle = this.runs.get(runId);
    if (!handle || handle.status !== 'running' || handle.cancelled) {
      return Promise.reject(new Error('Run cancelled'));
    }

    const hasOptions = (request.options?.length ?? 0) > 0;
    if (!hasOptions && handle.grantedTools.has(request.toolName)) {
      return Promise.resolve({});
    }

    const approvalId = randomUUID();
    const signal = handle.abortController.signal;

    handle.emitter.emit({
      type: 'approval.requested',
      runId,
      approvalId,
      toolName: request.toolName,
      summary: request.summary,
      risk: request.risk,
      ...(request.options ? { options: request.options } : {}),
      ...(request.argsPreview !== undefined
        ? { argsPreview: request.argsPreview }
        : {}),
    });

    return new Promise<ApprovalResult>((resolve, reject) => {
      const onAbort = () => {
        handle.pendingApprovals.delete(approvalId);
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error('Run cancelled'),
        );
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });
      handle.pendingApprovals.set(approvalId, {
        toolName: request.toolName,
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

  /** Apply a human decision to a pending approval. */
  resolveApproval(
    runId: string,
    approvalId: string,
    decision: ApprovalDecision,
    optionId?: string,
  ): ResolveApprovalResult {
    const handle = this.runs.get(runId);
    if (!handle || handle.status !== 'running' || handle.cancelled) {
      return 'not_found';
    }
    const pending = handle.pendingApprovals.get(approvalId);
    if (!pending) return 'not_found';

    const options = pending.options ?? [];
    if (decision !== 'denied' && options.length > 0) {
      if (!optionId || !options.some((option) => option.id === optionId)) {
        return 'invalid_option';
      }
    }

    handle.pendingApprovals.delete(approvalId);
    if (decision === 'approved_for_run' && options.length === 0) {
      handle.grantedTools.add(pending.toolName);
    }

    handle.emitter.emit({
      type: 'approval.resolved',
      runId,
      approvalId,
      decision,
      ...(optionId ? { optionId } : {}),
    });

    if (decision === 'denied') {
      pending.reject(new ApprovalDenied());
    } else {
      pending.resolve({ ...(optionId ? { optionId } : {}) });
    }
    return 'ok';
  }

  requestChoice(runId: string, request: ChoiceRequest): Promise<ChoiceResult> {
    const handle = this.runs.get(runId);
    if (!handle || handle.status !== 'running' || handle.cancelled) {
      return Promise.reject(new Error('Run cancelled'));
    }

    const choiceId = randomUUID();
    const signal = handle.abortController.signal;

    handle.emitter.emit({
      type: 'choice.requested',
      runId,
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
            : new Error('Run cancelled'),
        );
      };

      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });
      handle.pendingChoices.set(choiceId, {
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
    if (!handle || handle.status !== 'running' || handle.cancelled) {
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

  /** Live run for this thread, if any. Used so the client can reattach after reload. */
  activeRunIdForThread(threadId: string): string | undefined {
    for (const handle of this.runs.values()) {
      if (handle.threadId === threadId && handle.status === 'running') {
        return handle.runId;
      }
    }
    return undefined;
  }

  /** Abort in-flight model/tool work and stop SSE for this run. */
  cancel(runId: string): boolean {
    const handle = this.runs.get(runId);
    if (!handle || handle.status !== 'running' || handle.cancelled) {
      return false;
    }

    handle.cancelled = true;
    handle.abortController.abort(new Error('Run cancelled'));
    handle.emitter.emit({
      type: 'run.error',
      runId,
      error: 'Run cancelled',
    });
    return true;
  }

  /** Get a run handle. Returns undefined if not found. */
  get(runId: string): RunHandle | undefined {
    return this.runs.get(runId);
  }

  /** Subscribe to a run's events. Optionally replay from a seq cursor. */
  subscribe(
    runId: string,
    fromSeq: number,
    subscriber: EventSubscriber,
  ): () => void {
    const handle = this.runs.get(runId);
    if (!handle) {
      throw new Error(`Run not found: ${runId}`);
    }

    // Replay buffered events after the cursor.
    const replayEvents = handle.emitter.getEventsFromSeq(fromSeq);
    for (const event of replayEvents) {
      subscriber(event);
    }

    // Subscribe to live events (only if the run is still running).
    if (handle.status === 'running') {
      return handle.emitter.subscribe(subscriber);
    }

    // Run is done — no live events to subscribe to.
    // eslint-disable-next-line @typescript-eslint/no-empty-function
    return () => {};
  }

  /** Get the current event buffer for a run (for SSE replay). */
  getEvents(runId: string, fromSeq = 0): AgentEvent[] {
    const handle = this.runs.get(runId);
    if (!handle) return [];
    return handle.emitter.getEventsFromSeq(fromSeq);
  }

  /** Check if a run is still active. */
  isRunning(runId: string): boolean {
    const handle = this.runs.get(runId);
    return handle?.status === 'running';
  }

  /** Clear a completed run's buffer. */
  clear(runId: string): void {
    const handle = this.runs.get(runId);
    if (handle) {
      handle.emitter.dispose();
    }
    this.runs.delete(runId);
  }

  /** Check if a thread has an active run. */
  hasActiveRun(threadId: string): boolean {
    for (const handle of this.runs.values()) {
      if (handle.threadId === threadId && handle.status === 'running') {
        return true;
      }
    }
    return false;
  }
}

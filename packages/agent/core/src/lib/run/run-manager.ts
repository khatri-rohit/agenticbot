import { randomUUID } from 'node:crypto';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import type { AgentEvent } from '@org/agent-models';
import { runLoop, type ModelCallFn, type RunLoopResult } from '../loop/loop';
import { EventEmitter, type EventSubscriber } from '../events/emitter';
import type { ToolRegistry } from '../tools/type';

export type RunHandle = {
  runId: string;
  threadId: string;
  status: 'running' | 'completed' | 'error';
  cancelled: boolean;
  emitter: EventEmitter;
  result: RunLoopResult | null;
};

export type StartRunOptions = {
  threadId: string;
  model: string;
  streaming: boolean;
  messages: ChatCompletionMessageParam[];
  tools: ToolRegistry;
  modelCall: ModelCallFn;
  limits?: import('../loop/limits').AgentLimits;
};

/**
 * In-memory run manager. Holds live run state and event emitters.
 *
 * One active run per thread (enforced by the caller — the API layer).
 * When a run completes, its handle stays until explicitly cleared
 * (so late SSE subscribers can still replay).
 */
export class RunManager {
  private runs = new Map<string, RunHandle>();

  /** Start a run. Returns the runId immediately; the run executes async. */
  start(opts: StartRunOptions): string {
    const runId = randomUUID();
    const emitter = new EventEmitter();

    const handle: RunHandle = {
      runId,
      threadId: opts.threadId,
      status: 'running',
      cancelled: false,
      emitter,
      result: null,
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
      streaming: opts.streaming,
      limits: opts.limits,
      emit: (event) => {
        if (handle.cancelled) return;
        handle.emitter.emit(event);
      },
    });

    if (handle.cancelled) return;

    handle.status = result.status === 'error' ? 'error' : 'completed';
    handle.result = result;
  }

  /** Stop a run so a new one can start on the same thread. */
  cancel(runId: string): boolean {
    const handle = this.runs.get(runId);
    if (!handle || handle.status !== 'running') return false;

    handle.cancelled = true;
    handle.status = 'error';
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

import {
  isThreadPlanEmpty,
  normalizeRunPosture,
  type ActiveRun,
  type AgentEvent,
  type LedgerResponse,
  type Message,
  type MessageAttachment,
  type ThreadPlan,
} from '@agent/agent-models';
import {
  cancelRun,
  resolveChoice,
  startRun,
  subscribeRun,
  type ComposerOptions,
} from '@/api/agent-client';
import { fetchLedger, seqFromMessageId } from '@/api/thread-client';
import { resolveOllamaModel } from '@/features/composer/ollama-models';
import { skillTokensInText } from '@/features/composer/skill-slash-picker';
import { refreshThreads } from '@/features/threads/thread-cache';
import { toastError } from '@/hooks/use-toast';
import {
  applyChatEvent,
  hasSseSeqGap,
  initialChatState,
  limitNoticeFromIncomplete,
  noticeFromSnapshot,
  persistChatEffects,
  type ChatRunState,
  type ChatState,
  type CompactionNotice,
} from './chat-store';
import { observeRunEvent } from './run-alerts';

export type QueuedMessage = {
  content: string;
  options: ComposerOptions;
  attachments?: MessageAttachment[];
};

export type ThreadView = {
  messages: Message[];
  chat: ChatState;
  queued: QueuedMessage | null;
  /** A POST /run is in flight: the thread counts as busy, sends queue. */
  starting: boolean;
};

export type ChoiceAnswer = { skipped: true } | { optionIds: string[]; text?: string };

/** The HTTP calls the session makes; tests can pass their own. */
const http = { startRun, subscribeRun, cancelRun, resolveChoice, fetchLedger };
export type ThreadTransport = typeof http;

/**
 * A plan is current iff it was written after the thread's last user message
 * (plan revisions are stamped with the ledger seq of the tool row that
 * followed their write). Older plans belong to settled turns: they render as
 * chips from history, never as live state.
 */
function planFromLedger(ledger: LedgerResponse): ThreadPlan | null {
  const { plan, lastUserSeq } = ledger;
  if (!plan || isThreadPlanEmpty(plan) || lastUserSeq === undefined) return null;
  return (plan.ledgerSeq ?? 0) > lastUserSeq ? plan : null;
}

/** The snapshot on disk, unless the stream already reported a newer one. */
function compactionFromLedger(
  ledger: LedgerResponse,
  live: CompactionNotice | null,
): CompactionNotice | null {
  if (!ledger.snapshot) return live?.status === 'running' ? live : null;
  const fromDisk = noticeFromSnapshot(ledger.snapshot);
  return live && live.throughSeq > fromDisk.throughSeq ? live : fromDisk;
}

/**
 * What the ledger decides about a thread, used on load, at every run's end,
 * and after retry/edit, so all of them agree with a reload. Notices belong to
 * the last settled run, and only while its reply is the newest in the thread.
 */
function viewFromLedger(
  ledger: LedgerResponse,
  live: ChatState,
): Pick<ChatState, 'plan' | 'compactionNotice' | 'limitNotice' | 'system1Notice'> {
  const lastReply = ledger.messages.findLast((m) => m.role === 'assistant');
  const lastRun =
    ledger.lastRun && !ledger.activeRun && ledger.lastRun.runId === lastReply?.runId
      ? ledger.lastRun
      : undefined;
  return {
    plan: planFromLedger(ledger),
    compactionNotice: compactionFromLedger(ledger, live.compactionNotice),
    limitNotice: limitNoticeFromIncomplete(lastRun) ?? null,
    system1Notice: lastRun?.system1
      ? { runId: lastRun.runId, report: lastRun.system1 }
      : null,
  };
}

/** The live run as the ledger reports it, before (or without) its opening events. */
function runFromSummary(run: ActiveRun): ChatRunState {
  return {
    runId: run.runId,
    status: 'running',
    model: run.model,
    posture: run.posture,
    streamingMessage: null,
    toolActivity: [],
    subagentActivity: [],
    assistantSnippets: [],
    lastSeq: 0,
    ...(run.startedAt ? { runStartedAt: run.startedAt } : {}),
  };
}

function runRequest(options: ComposerOptions) {
  const local = options.local === true;
  return {
    webSearch: options.webSearch,
    model: resolveOllamaModel(options.model, local),
    local,
    thinking: options.thinking,
    posture: normalizeRunPosture(options.posture),
    ...(options.skills ? { skills: options.skills } : {}),
    contextWindowMode: options.contextWindowMode ?? 'default',
  };
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export type ThreadSession = ReturnType<typeof createThreadSession>;

/**
 * One thread's conversation state outside React: the ledger view, the live
 * run (one event stream at a time), the queued message, and every action
 * that starts or steers a run. React reads it through `useSyncExternalStore`.
 */
export function createThreadSession(
  threadId: string,
  transport: ThreadTransport = http,
) {
  let view: ThreadView = {
    messages: [],
    chat: initialChatState(),
    queued: null,
    starting: false,
  };
  const listeners = new Set<() => void>();
  let disposed = false;
  let disconnect: (() => void) | null = null;

  function update(next: Partial<ThreadView>): void {
    if (disposed) return;
    view = { ...view, ...next };
    for (const listener of listeners) listener();
  }

  const busy = () => view.starting || view.chat.activeRun !== null;

  /** Rebuild from the ledger; attach to the run in progress, if any. */
  async function load(): Promise<void> {
    let ledger: LedgerResponse;
    try {
      ledger = await transport.fetchLedger(threadId);
    } catch (error) {
      console.error('Failed to load ledger', error);
      return;
    }
    if (disposed) return;
    const active = ledger.activeRun;
    const chat: ChatState = {
      ...initialChatState(),
      ...viewFromLedger(ledger, view.chat),
      ...(active
        ? {
            activeRun: runFromSummary(active),
            pendingChoices: active.pendingChoices.map((choice) => ({
              ...choice,
              runId: active.runId,
            })),
          }
        : {}),
    };
    update({ messages: ledger.messages, chat });
    if (active) follow(active.runId);
  }

  /** The run ended (run.settled): one ledger read updates messages and notices together. */
  async function settle(): Promise<void> {
    try {
      const ledger = await transport.fetchLedger(threadId);
      if (disposed) return;
      update({
        messages: ledger.messages,
        chat: {
          ...view.chat,
          ...viewFromLedger(ledger, view.chat),
          // The ledger holds the committed messages now; drop the bridge.
          settledSnippets: [],
          settledToolActivity: [],
        },
      });
    } catch {
      // The next load or run end rebuilds it.
    }
    void refreshThreads();
    if (!busy() && view.queued) void flushQueue();
  }

  async function refreshMessages(): Promise<void> {
    try {
      const ledger = await transport.fetchLedger(threadId);
      if (!disposed) update({ messages: ledger.messages });
    } catch {
      // Best effort: the run's end refetches anyway.
    }
  }

  /** Stream one run's events into the view. A new run replaces the old stream. */
  function follow(runId: string): void {
    disconnect?.();
    let chain = Promise.resolve();
    const unsubscribe = transport.subscribeRun(
      runId,
      view.chat.activeRun?.runId === runId ? view.chat.activeRun.lastSeq : 0,
      (event: AgentEvent) => {
        chain = chain.then(async () => {
          if (disposed || disconnect !== unsubscribe) return;
          const prev = view.chat;
          // A run attached from the ledger starts at seq 0 and its first
          // replayed event is usually far ahead; that read already happened.
          const lastSeq = prev.activeRun?.lastSeq ?? 0;
          if (lastSeq > 0 && hasSseSeqGap(lastSeq, event.seq)) {
            void refreshMessages();
          }
          await persistChatEffects(prev, event, threadId);
          if (disposed || disconnect !== unsubscribe) return;
          update({ chat: applyChatEvent(view.chat, event) });
          observeRunEvent({
            event,
            subscribedRunId: runId,
            subscribedThreadId: threadId,
            liveThreadId: threadId,
          });
          if (event.type === 'context.compacted') void refreshMessages();
          if (event.type === 'run.settled') {
            disconnect = null;
            await settle();
          }
        });
      },
      (error) => console.error('SSE error:', error),
    );
    disconnect = unsubscribe;
  }

  /**
   * POST /run, then show the ledger it wrote and follow the run. A failed
   * start keeps the message: it goes back to the queue chip.
   */
  async function start(
    request: Parameters<ThreadTransport['startRun']>[1],
    unsent?: QueuedMessage,
  ): Promise<void> {
    update({ starting: true });
    disconnect?.();
    disconnect = null;
    try {
      await transport.startRun(threadId, request);
    } catch (error) {
      update({ starting: false, ...(unsent ? { queued: unsent } : {}) });
      toastError(errorMessage(error, 'Could not start the run'), 'Send failed');
      // The thread may have changed (a user row is kept; Retry re-runs it).
      await refreshMessages();
      return;
    }
    // Title and recency changed; the sidebar picks them up.
    void refreshThreads();
    await load();
    update({ starting: false });
  }

  async function flushQueue(): Promise<void> {
    const queued = view.queued;
    if (!queued) return;
    update({ queued: null });
    await start(
      {
        message: { content: queued.content, attachments: queued.attachments },
        ...runRequest(queued.options),
      },
      queued,
    );
  }

  /** Starts now, or queues while a run is live (it then starts when that run settles). */
  async function send(
    content: string,
    options: ComposerOptions,
    attachments?: MessageAttachment[],
  ): Promise<void> {
    update({ queued: { content, options, ...(attachments ? { attachments } : {}) } });
    if (!busy()) await flushQueue();
  }

  /**
   * Stop the live run. The stream then reports the cancel and, once the run
   * has written its last rows, its end; nothing is cleared by hand here.
   */
  async function stop(): Promise<void> {
    const run = view.chat.activeRun;
    if (!run) return;
    let active: boolean;
    try {
      active = await transport.cancelRun(run.runId);
    } catch (error) {
      toastError(errorMessage(error, 'Could not stop the run'), 'Stop failed');
      return;
    }
    if (active) return;
    // Already over: the ledger has the result.
    disconnect?.();
    disconnect = null;
    update({ chat: { ...view.chat, activeRun: null } });
    await settle();
  }

  /** Stop the live run and start the queued message (the server waits for the stop). */
  async function sendQueuedNow(posture: ComposerOptions['posture']): Promise<void> {
    const queued = view.queued;
    if (!queued) return;
    // The posture chip as it is now wins over the one frozen at enqueue.
    update({ queued: { ...queued, options: { ...queued.options, posture } } });
    await stop();
    await flushQueue();
  }

  /**
   * Run the last user message again: rewind past the reply, or, when the
   * thread ends with that message (the start failed or was stopped before
   * any reply), run it as it is.
   */
  async function retry(options: ComposerOptions): Promise<void> {
    if (busy()) return;
    const { lastUserSeq, lastSeq } = await transport.fetchLedger(threadId);
    if (lastUserSeq === undefined) return;
    await start({
      ...(lastUserSeq === lastSeq ? {} : { rewindThroughSeq: lastUserSeq }),
      ...runRequest(options),
    });
  }

  /** Replace the last user message and run it. */
  async function edit(
    messageId: string,
    content: string,
    options: ComposerOptions,
  ): Promise<void> {
    const trimmed = content.trim();
    const lastUser = view.messages.findLast((m) => m.role === 'user');
    const userSeq = seqFromMessageId(messageId);
    if (!lastUser || lastUser.id !== messageId || userSeq === undefined) return;
    if (!trimmed && !(lastUser.attachments?.length ?? 0)) return;
    await stop();
    const requested = skillTokensInText(trimmed);
    await start({
      rewindThroughSeq: userSeq - 1,
      message: { content: trimmed, attachments: lastUser.attachments },
      ...runRequest(options),
      ...(requested.length > 0 ? { skills: { requested } } : {}),
    });
  }

  /** Answer a choice the run is paused on (its own run id survives a reload). */
  async function answerChoice(choiceId: string, answer: ChoiceAnswer): Promise<void> {
    const choice = view.chat.pendingChoices.find((c) => c.choiceId === choiceId);
    if (!choice) return;
    try {
      await transport.resolveChoice(
        choice.runId,
        'skipped' in answer ? { choiceId, skipped: true } : { choiceId, ...answer },
      );
    } catch (error) {
      toastError(errorMessage(error, 'Could not send choice'), 'Choice failed');
      throw error;
    }
  }

  void load();

  return {
    getSnapshot: (): ThreadView => view,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send,
    sendQueuedNow,
    /** Take the queued message back into the composer. */
    takeQueued(): QueuedMessage | null {
      const queued = view.queued;
      update({ queued: null });
      return queued;
    },
    stop,
    retry,
    edit,
    answerChoice,
    dispose(): void {
      disposed = true;
      disconnect?.();
      disconnect = null;
      listeners.clear();
    },
  };
}

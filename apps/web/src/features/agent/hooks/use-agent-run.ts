import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useSyncExternalStore,
} from 'react';
import {
  isWorkspaceKind,
  normalizeRunPosture,
  type AgentEvent,
  type Message,
  type MessageAttachment,
  type ThreadKind,
} from '@org/agent-models';
import { toastError } from '@/hooks/use-toast';
import {
  modelSupportsVision,
  readStoredComposerLocal,
  readStoredComposerModel,
  resolveOllamaModel,
  writeStoredComposerLocal,
  writeStoredComposerModel,
} from '@/lib/ollama-models';
import {
  applyChatEvent,
  initialChatState,
  noticeFromSnapshot,
  persistChatEffects,
  type ChatState,
} from '../store/chat-store';
import {
  startRun,
  subscribeRun,
  cancelRun,
  type ComposerOptions,
} from '../api/agent-client';
import {
  fetchLedger,
  fetchThread,
  patchThread,
  seqFromMessageId,
} from '../api/thread-client';
import {
  ensureThreadsLoaded,
  getThreadsSnapshot,
  refreshThreads,
  subscribeThreads,
} from '../store/thread-cache';
import { setWorkspaceRoot } from '../store/space-store';

export type QueuedMessage = {
  content: string;
  options: ComposerOptions;
  attachments?: MessageAttachment[];
};

const defaultComposerOptions = (): ComposerOptions => {
  const local = readStoredComposerLocal();
  return {
    streaming: true,
    webSearch: true,
    local,
    model: readStoredComposerModel(local),
    posture: 'agent',
  };
};

/**
 * Hook for managing an active agent run.
 * Starts a run, subscribes to SSE events, reduces them into ephemeral
 * ChatState; durable history comes from the host ledger.
 */
export function useAgentRun(threadId: string | null) {
  const [chatState, setChatState] = useState<ChatState>(initialChatState());
  const [queuedMessage, setQueuedMessage] = useState<QueuedMessage | null>(
    null,
  );
  const [composerOptions, setComposerOptions] = useState<ComposerOptions>(
    defaultComposerOptions,
  );

  const unsubscribeRef = useRef<(() => void) | null>(null);
  const chatStateRef = useRef(chatState);
  chatStateRef.current = chatState;
  const wasRunningRef = useRef(false);
  const syncedThreadModelRef = useRef<string | null>(null);
  const [threadKind, setThreadKind] = useState<ThreadKind>('home');
  const [ledgerEpoch, setLedgerEpoch] = useState(0);
  const bumpLedger = useCallback(() => {
    setLedgerEpoch((n) => n + 1);
  }, []);

  useEffect(() => {
    setChatState(initialChatState());
    if (!threadId) return;
    let cancelled = false;
    void fetchThread(threadId).then((thread) => {
      if (cancelled || !thread) return;
      if (syncedThreadModelRef.current === thread.id) return;
      syncedThreadModelRef.current = thread.id;
      const workspace = isWorkspaceKind(thread.kind);
      setThreadKind(workspace ? 'workspace' : 'home');
      if (workspace && thread.workspaceRoot) {
        setWorkspaceRoot(thread.workspaceRoot);
      } else {
        setWorkspaceRoot(null);
      }
      setComposerOptions((prev) => {
        const local = prev.local === true;
        const model = resolveOllamaModel(thread.model, local);
        return {
          ...prev,
          model,
          webSearch: prev.webSearch,
        };
      });
    });
    void fetchLedger(threadId)
      .then((ledger) => {
        if (cancelled) return;
        setChatState((prev) => ({
          ...prev,
          ...(ledger.snapshot
            ? { compactionNotice: noticeFromSnapshot(ledger.snapshot) }
            : {}),
          plan: ledger.plan ?? prev.plan,
        }));
      })
      .catch(() => {
        /* ledger hydrate is best-effort for the compaction card */
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const setComposerOptionsPersisted = useCallback(
    (options: ComposerOptions) => {
      const local = options.local === true;
      const model = resolveOllamaModel(options.model, local);
      const next = { ...options, local, model };
      setComposerOptions(next);
      writeStoredComposerLocal(local);
      writeStoredComposerModel(model, local);
      if (!threadId || !model) return;
      void fetchThread(threadId).then((thread) => {
        if (!thread || thread.model === model) return;
        void patchThread(threadId, { model }).then(() => refreshThreads());
      });
    },
    [threadId],
  );

  const disconnect = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
  }, []);

  const subscribeToRun = useCallback(
    (runId: string) => {
      if (!threadId) return;

      const prior = chatStateRef.current;
      // Same run: keep UI + lastSeq; new run: clear active run, keep compaction card.
      let currentState =
        prior.activeRun?.runId === runId
          ? prior
          : {
              ...initialChatState(),
              compactionNotice: prior.compactionNotice,
              plan: prior.plan,
            };
      const fromSeq = currentState.activeRun?.lastSeq ?? 0;
      let eventChain = Promise.resolve();
      disconnect();
      unsubscribeRef.current = subscribeRun(
        runId,
        fromSeq,
        (event: AgentEvent) => {
          eventChain = eventChain.then(async () => {
            const prev = currentState;
            const next = applyChatEvent(prev, event);
            await persistChatEffects(prev, event, threadId);
            currentState = next;
            setChatState(next);
            if (
              event.type === 'run.settled' ||
              event.type === 'run.error' ||
              event.type === 'context.compacted'
            ) {
              bumpLedger();
              void refreshThreads();
            }
            if (event.type === 'run.settled' || event.type === 'run.error') {
              // Sync card with snapshot.json (rewind may have deleted it).
              void fetchLedger(threadId)
                .then((ledger) => {
                  setChatState((prev) => {
                    const withPlan = {
                      ...prev,
                      plan: ledger.plan ?? prev.plan,
                    };
                    if (ledger.snapshot) {
                      const fromDisk = noticeFromSnapshot(ledger.snapshot);
                      if (
                        prev.compactionNotice &&
                        prev.compactionNotice.throughSeq > fromDisk.throughSeq
                      ) {
                        return withPlan;
                      }
                      return { ...withPlan, compactionNotice: fromDisk };
                    }
                    if (prev.compactionNotice?.runId === event.runId) {
                      return withPlan;
                    }
                    return { ...withPlan, compactionNotice: null };
                  });
                })
                .catch(() => {
                  /* ignore */
                });
            }
          });
        },
        (error) => {
          console.error('SSE error:', error);
        },
      );
    },
    [threadId, disconnect, bumpLedger],
  );

  const startRunForMessages = useCallback(
    async (
      content: string,
      options: ComposerOptions,
      {
        skipQueue,
        attachments,
      }: { skipQueue?: boolean; attachments?: MessageAttachment[] } = {},
    ) => {
      if (!threadId) return;

      // Defense in depth for cloud catalog; local models rely on live /api/show
      // (composer) + server vision check — catalog flags are not available.
      if (
        (attachments?.length ?? 0) > 0 &&
        options.local !== true &&
        !modelSupportsVision(options.model)
      ) {
        toastError(
          'This model does not support images. Pick a vision model.',
          'Vision not supported',
        );
        return;
      }

      if (chatStateRef.current.activeRun) {
        if (!skipQueue) {
          setQueuedMessage({ content, options, attachments });
        }
        return;
      }

      const local = options.local === true;
      const runId = await startRun(threadId, {
        message: { content, attachments },
        streaming: options.streaming,
        webSearch: options.webSearch,
        model: resolveOllamaModel(options.model, local),
        local,
        thinking: options.thinking,
        posture: normalizeRunPosture(options.posture),
      });

      setChatState((prev) => ({
        ...initialChatState(),
        compactionNotice: prev.compactionNotice,
      }));
      bumpLedger();
      // Server writes a model-generated title on first turn before /run returns.
      void refreshThreads();

      subscribeToRun(runId);
    },
    [threadId, subscribeToRun, bumpLedger],
  );

  const interruptActiveRun = useCallback(async () => {
    const state = chatStateRef.current;
    const run = state.activeRun;
    if (!run) return;

    disconnect();

    if (run.status === 'running') {
      try {
        await cancelRun(run.runId);
      } catch (err) {
        console.error('Cancel run failed:', err);
      }
    }

    setChatState((prev) => ({
      ...initialChatState(),
      compactionNotice: prev.compactionNotice,
    }));
  }, [disconnect]);

  const sendMessage = useCallback(
    async (
      content: string,
      options: Partial<ComposerOptions> = {},
      attachments?: MessageAttachment[],
    ) => {
      const local = options.local ?? composerOptions.local === true;
      const merged: ComposerOptions = {
        streaming: options.streaming ?? composerOptions.streaming,
        webSearch: options.webSearch ?? composerOptions.webSearch,
        local,
        model: resolveOllamaModel(
          options.model ?? composerOptions.model,
          local,
        ),
        thinking: options.thinking ?? composerOptions.thinking,
        posture: normalizeRunPosture(
          options.posture ?? composerOptions.posture,
        ),
      };

      if (chatStateRef.current.activeRun) {
        setQueuedMessage({ content, options: merged, attachments });
        return;
      }

      await startRunForMessages(content, merged, { attachments });
    },
    [composerOptions, startRunForMessages],
  );

  const sendQueuedNow = useCallback(async () => {
    if (!queuedMessage) return;
    const { content, options, attachments } = queuedMessage;
    // Live chip wins over posture frozen at enqueue.
    const flushOptions: ComposerOptions = {
      ...options,
      posture: normalizeRunPosture(composerOptions.posture),
    };
    setQueuedMessage(null);
    await interruptActiveRun();
    await startRunForMessages(content, flushOptions, {
      skipQueue: true,
      attachments,
    });
  }, [
    queuedMessage,
    composerOptions.posture,
    interruptActiveRun,
    startRunForMessages,
  ]);

  const editQueuedMessage = useCallback((): {
    content: string;
    attachments?: MessageAttachment[];
  } | null => {
    if (!queuedMessage) return null;
    const { content, attachments } = queuedMessage;
    setQueuedMessage(null);
    return { content, attachments };
  }, [queuedMessage]);

  const clearQueuedMessage = useCallback(() => {
    setQueuedMessage(null);
  }, []);

  const retryLastResponse = useCallback(async () => {
    if (!threadId) return;
    if (chatStateRef.current.activeRun) return;

    const ledger = await fetchLedger(threadId);
    if (ledger.lastUserSeq === undefined) return;
    if (ledger.lastUserSeq === ledger.lastSeq) return;

    const local = composerOptions.local === true;
    const runId = await startRun(threadId, {
      rewindThroughSeq: ledger.lastUserSeq,
      streaming: composerOptions.streaming,
      webSearch: composerOptions.webSearch,
      model: resolveOllamaModel(composerOptions.model, local),
      local,
      thinking: composerOptions.thinking,
      posture: normalizeRunPosture(composerOptions.posture),
    });

    setChatState((prev) => ({
      ...initialChatState(),
      compactionNotice: prev.compactionNotice,
    }));
    bumpLedger();
    subscribeToRun(runId);
  }, [threadId, composerOptions, subscribeToRun, bumpLedger]);

  const editLastUserMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!threadId) return;
      const trimmed = newContent.trim();

      if (chatStateRef.current.activeRun) {
        await interruptActiveRun();
      }

      const ledger = await fetchLedger(threadId);
      let lastUser: Message | null = null;
      for (let i = ledger.messages.length - 1; i >= 0; i--) {
        if (ledger.messages[i].role === 'user') {
          lastUser = ledger.messages[i];
          break;
        }
      }
      if (!lastUser || lastUser.id !== messageId) return;
      if (!trimmed && !(lastUser.attachments?.length ?? 0)) return;

      const userSeq = seqFromMessageId(messageId);
      if (userSeq === undefined) return;

      const local = composerOptions.local === true;
      const runId = await startRun(threadId, {
        rewindThroughSeq: userSeq - 1,
        message: { content: trimmed, attachments: lastUser.attachments },
        streaming: composerOptions.streaming,
        webSearch: composerOptions.webSearch,
        model: resolveOllamaModel(composerOptions.model, local),
        local,
        thinking: composerOptions.thinking,
        posture: normalizeRunPosture(composerOptions.posture),
      });

      setChatState((prev) => ({
        ...initialChatState(),
        compactionNotice: prev.compactionNotice,
      }));
      bumpLedger();
      subscribeToRun(runId);
    },
    [threadId, composerOptions, subscribeToRun, interruptActiveRun, bumpLedger],
  );

  useEffect(() => {
    // activeRun stays until run.settled (covers post-loop compaction).
    const busy = chatState.activeRun !== null;
    if (wasRunningRef.current && !busy && queuedMessage) {
      const { content, options, attachments } = queuedMessage;
      // Live chip wins over posture frozen at enqueue.
      const flushOptions: ComposerOptions = {
        ...options,
        posture: normalizeRunPosture(composerOptions.posture),
      };
      setQueuedMessage(null);
      void startRunForMessages(content, flushOptions, {
        skipQueue: true,
        attachments,
      });
    }
    wasRunningRef.current = busy;
  }, [
    chatState.activeRun,
    queuedMessage,
    composerOptions.posture,
    startRunForMessages,
  ]);

  return {
    chatState,
    composerOptions,
    setComposerOptions: setComposerOptionsPersisted,
    queuedMessage,
    sendMessage,
    sendQueuedNow,
    editQueuedMessage,
    clearQueuedMessage,
    retryLastResponse,
    editLastUserMessage,
    disconnect,
    stopGeneration: interruptActiveRun,
    // Busy through post-loop compaction until run.settled clears activeRun.
    isRunning: chatState.activeRun !== null,
    ledgerEpoch,
    threadKind,
  };
}

export function useThreads() {
  const threads = useSyncExternalStore(
    subscribeThreads,
    getThreadsSnapshot,
    getThreadsSnapshot,
  );
  useEffect(() => {
    ensureThreadsLoaded();
  }, []);
  return threads;
}

export function useMessages(threadId: string | null, ledgerEpoch = 0) {
  const [messages, setMessages] = useState<Message[]>([]);

  useEffect(() => {
    if (!threadId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void fetchLedger(threadId)
      .then((ledger) => {
        if (!cancelled) setMessages(ledger.messages);
      })
      .catch((error) => {
        console.error('Failed to load ledger', error);
      });
    return () => {
      cancelled = true;
    };
  }, [threadId, ledgerEpoch]);

  return messages;
}

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useSyncExternalStore,
} from 'react';
import type {
  AgentEvent,
  Message,
  MessageAttachment,
  ThreadKind,
} from '@org/agent-models';
import { toastError } from '@/hooks/use-toast';
import {
  modelSupportsVision,
  readStoredComposerModel,
  resolveOllamaModel,
  writeStoredComposerModel,
} from '@/lib/ollama-models';
import {
  applyChatEvent,
  initialChatState,
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
import { setAgentSpace, setWorkspaceRoot } from '../store/space-store';

export type QueuedMessage = {
  content: string;
  options: ComposerOptions;
  attachments?: MessageAttachment[];
};

const defaultComposerOptions = (): ComposerOptions => ({
  streaming: true,
  webSearch: true,
  model: readStoredComposerModel(),
});

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
  const [threadKind, setThreadKind] = useState<ThreadKind>('research');
  const [ledgerEpoch, setLedgerEpoch] = useState(0);
  const bumpLedger = useCallback(() => {
    setLedgerEpoch((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    void fetchThread(threadId).then((thread) => {
      if (cancelled || !thread) return;
      if (syncedThreadModelRef.current === thread.id) return;
      syncedThreadModelRef.current = thread.id;
      const model = resolveOllamaModel(thread.model);
      const coding = thread.kind === 'coding';
      setThreadKind(coding ? 'coding' : 'research');
      if (coding) {
        setAgentSpace('coding');
        if (thread.workspaceRoot) setWorkspaceRoot(thread.workspaceRoot);
      } else {
        setAgentSpace('research');
      }
      setComposerOptions((prev) => ({
        ...prev,
        model,
        webSearch: coding ? false : prev.webSearch,
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const setComposerOptionsPersisted = useCallback(
    (options: ComposerOptions) => {
      const model = resolveOllamaModel(options.model);
      const next = { ...options, model };
      setComposerOptions(next);
      writeStoredComposerModel(model);
      if (!threadId) return;
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
      // Same run: keep UI + lastSeq; new run: start empty.
      let currentState =
        prior.activeRun?.runId === runId ? prior : initialChatState();
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
            if (event.type === 'run.completed' || event.type === 'run.error') {
              bumpLedger();
              void refreshThreads();
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

      // Defense in depth: composer also gates; covers queue flush + hero handoff.
      if (
        (attachments?.length ?? 0) > 0 &&
        !modelSupportsVision(options.model)
      ) {
        toastError(
          'This model does not support images. Pick a vision model.',
          'Vision not supported',
        );
        return;
      }

      if (chatStateRef.current.activeRun?.status === 'running') {
        if (!skipQueue) {
          setQueuedMessage({ content, options, attachments });
        }
        return;
      }

      const runId = await startRun(threadId, {
        message: { content, attachments },
        streaming: options.streaming,
        webSearch: options.webSearch,
        model: resolveOllamaModel(options.model),
        thinking: options.thinking,
      });

      setChatState(initialChatState());
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
    if (!run || run.status !== 'running') return;

    disconnect();

    try {
      await cancelRun(run.runId);
    } catch (err) {
      console.error('Cancel run failed:', err);
    }

    setChatState(initialChatState());
  }, [disconnect]);

  const sendMessage = useCallback(
    async (
      content: string,
      options: Partial<ComposerOptions> = {},
      attachments?: MessageAttachment[],
    ) => {
      const merged: ComposerOptions = {
        streaming: options.streaming ?? composerOptions.streaming,
        webSearch: options.webSearch ?? composerOptions.webSearch,
        model: resolveOllamaModel(options.model ?? composerOptions.model),
        thinking: options.thinking ?? composerOptions.thinking,
      };

      if (chatStateRef.current.activeRun?.status === 'running') {
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
    setQueuedMessage(null);
    await interruptActiveRun();
    await startRunForMessages(content, options, {
      skipQueue: true,
      attachments,
    });
  }, [queuedMessage, interruptActiveRun, startRunForMessages]);

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
    if (chatStateRef.current.activeRun?.status === 'running') return;

    const ledger = await fetchLedger(threadId);
    if (ledger.lastUserSeq === undefined) return;
    if (ledger.lastUserSeq === ledger.lastSeq) return;

    const runId = await startRun(threadId, {
      rewindThroughSeq: ledger.lastUserSeq,
      streaming: composerOptions.streaming,
      webSearch: composerOptions.webSearch,
      model: resolveOllamaModel(composerOptions.model),
      thinking: composerOptions.thinking,
    });

    setChatState(initialChatState());
    bumpLedger();
    subscribeToRun(runId);
  }, [threadId, composerOptions, subscribeToRun, bumpLedger]);

  const editLastUserMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!threadId) return;
      const trimmed = newContent.trim();

      if (chatStateRef.current.activeRun?.status === 'running') {
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

      const runId = await startRun(threadId, {
        rewindThroughSeq: userSeq - 1,
        message: { content: trimmed, attachments: lastUser.attachments },
        streaming: composerOptions.streaming,
        webSearch: composerOptions.webSearch,
        model: resolveOllamaModel(composerOptions.model),
        thinking: composerOptions.thinking,
      });

      setChatState(initialChatState());
      bumpLedger();
      subscribeToRun(runId);
    },
    [threadId, composerOptions, subscribeToRun, interruptActiveRun, bumpLedger],
  );

  useEffect(() => {
    const running = chatState.activeRun?.status === 'running';
    if (wasRunningRef.current && !running && queuedMessage) {
      const { content, options, attachments } = queuedMessage;
      setQueuedMessage(null);
      void startRunForMessages(content, options, {
        skipQueue: true,
        attachments,
      });
    }
    wasRunningRef.current = running;
  }, [chatState.activeRun, queuedMessage, startRunForMessages]);

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
    isRunning: chatState.activeRun?.status === 'running',
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

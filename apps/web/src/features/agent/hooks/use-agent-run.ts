import { useState, useCallback, useRef, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AgentEvent, MessageAttachment, Thread } from '@org/agent-models';
import { clampChatTitle } from '@/lib/thread-title';
import { toastError } from '@/hooks/use-toast';
import {
  modelSupportsVision,
  readStoredComposerModel,
  resolveOllamaModel,
  writeStoredComposerModel,
} from '@/lib/ollama-models';
import { getUserPersona } from '@/lib/user-persona';
import { toChatContext } from '../lib/to-chat-context';
import {
  db,
  getMessages,
  getThread,
  addMessage,
  updateThread,
  updateRun,
  deleteMessagesAfter,
  updateMessageContent,
} from '../store/db';
import {
  initialChatState,
  reduceChatState,
  type ChatState,
} from '../store/chat-store';
import {
  startRun,
  subscribeRun,
  enqueueTitle,
  pollTitle,
  cancelRun,
  type ComposerOptions,
} from '../api/agent-client';

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
 * Starts a run, subscribes to SSE events, reduces them into ChatState,
 * and persists durable state to IndexedDB.
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

  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    void db.threads.get(threadId).then((thread) => {
      if (cancelled || !thread) return;
      if (syncedThreadModelRef.current === thread.id) return;
      syncedThreadModelRef.current = thread.id;
      const model = resolveOllamaModel(thread.model);
      setComposerOptions((prev) => ({ ...prev, model }));
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
      // Persist model without bumping sidebar `updatedAt` (see updateThread).
      void getThread(threadId).then((thread) => {
        if (!thread || thread.model === model) return;
        void updateThread(threadId, { model });
      });
    },
    [threadId],
  );

  const disconnect = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
  }, []);

  const persistInterruptedAssistant = useCallback(
    async (state: ChatState) => {
      if (!threadId) return;
      const run = state.activeRun;
      if (!run) return;
      const partial = run?.streamingMessage;
      if (!partial?.content) return;

      await addMessage({
        id: partial.id,
        threadId,
        runId: run.runId,
        role: 'assistant',
        content: partial.content,
        status: 'interrupted',
        createdAt: new Date().toISOString(),
      });
    },
    [threadId],
  );

  const subscribeToRun = useCallback(
    (runId: string) => {
      if (!threadId) return;

      let currentState = initialChatState();
      let eventChain = Promise.resolve();
      disconnect();
      unsubscribeRef.current = subscribeRun(
        runId,
        0,
        (event: AgentEvent) => {
          eventChain = eventChain.then(async () => {
            const next = await reduceChatState(currentState, event, threadId);
            currentState = next;
            setChatState(next);
          });
        },
        (error) => {
          console.error('SSE error:', error);
        },
      );
    },
    [threadId, disconnect],
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

      const userMessage = {
        id: crypto.randomUUID(),
        threadId,
        runId: null,
        role: 'user' as const,
        content,
        ...(attachments?.length ? { attachments } : {}),
        status: 'complete' as const,
        createdAt: new Date().toISOString(),
      };
      await addMessage(userMessage);

      const history = await getMessages(threadId);
      const contextMessages = toChatContext(history);

      const runId = await startRun(threadId, contextMessages, {
        streaming: options.streaming,
        webSearch: options.webSearch,
        model: resolveOllamaModel(options.model),
        thinking: options.thinking,
        userPersona: getUserPersona(),
      });

      setChatState(initialChatState());

      const isFirstMessage = history.length <= 1;
      if (isFirstMessage) {
        const titleSeed = content.trim() || '(image)';
        enqueueTitle(threadId, titleSeed)
          .then((jobId) => pollForTitle(jobId, threadId))
          .catch((err) => console.error('Title generation failed:', err));
      }

      subscribeToRun(runId);
    },
    [threadId, subscribeToRun],
  );

  const interruptActiveRun = useCallback(async () => {
    const state = chatStateRef.current;
    const run = state.activeRun;
    if (!run || run.status !== 'running') return;

    await persistInterruptedAssistant(state);
    disconnect();

    try {
      await cancelRun(run.runId);
    } catch (err) {
      console.error('Cancel run failed:', err);
    }

    await updateRun(run.runId, {
      status: 'error',
      completedAt: new Date().toISOString(),
      error: 'Cancelled',
    });

    setChatState(initialChatState());
  }, [disconnect, persistInterruptedAssistant]);

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

    const history = await getMessages(threadId);
    let lastUserIndex = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (lastUserIndex === -1) return;
    if (lastUserIndex === history.length - 1) return;

    const userMessage = history[lastUserIndex];
    await deleteMessagesAfter(threadId, userMessage.id);

    const remaining = await getMessages(threadId);
    const contextMessages = toChatContext(remaining);

    const runId = await startRun(threadId, contextMessages, {
      streaming: composerOptions.streaming,
      webSearch: composerOptions.webSearch,
      model: resolveOllamaModel(composerOptions.model),
      thinking: composerOptions.thinking,
      userPersona: getUserPersona(),
    });

    setChatState(initialChatState());
    subscribeToRun(runId);
  }, [threadId, composerOptions, subscribeToRun]);

  const editLastUserMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!threadId) return;
      const trimmed = newContent.trim();

      if (chatStateRef.current.activeRun?.status === 'running') {
        await interruptActiveRun();
      }

      const history = await getMessages(threadId);
      let lastUser: (typeof history)[number] | null = null;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'user') {
          lastUser = history[i];
          break;
        }
      }
      if (!lastUser || lastUser.id !== messageId) return;
      if (!trimmed && !(lastUser.attachments?.length ?? 0)) return;

      await updateMessageContent(messageId, trimmed);
      await deleteMessagesAfter(threadId, messageId);

      const remaining = await getMessages(threadId);
      const contextMessages = toChatContext(remaining);

      const runId = await startRun(threadId, contextMessages, {
        streaming: composerOptions.streaming,
        webSearch: composerOptions.webSearch,
        model: resolveOllamaModel(composerOptions.model),
        thinking: composerOptions.thinking,
        userPersona: getUserPersona(),
      });

      setChatState(initialChatState());
      subscribeToRun(runId);
    },
    [threadId, composerOptions, subscribeToRun, interruptActiveRun],
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
  };
}

async function pollForTitle(jobId: string, threadId: string): Promise<void> {
  const MAX_POLLS = 30;
  const INTERVAL_MS = 2000;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    const result = await pollTitle(jobId);

    if (result.status === 'completed') {
      await updateThread(threadId, { title: clampChatTitle(result.title) });
      return;
    }
    if (result.status === 'failed') {
      console.error('Title generation failed for thread', threadId);
      return;
    }
  }
  console.warn('Title generation timed out for thread', threadId);
}

function sortThreadsForSidebar(threads: Thread[]) {
  return [...threads].sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function useThreads() {
  return useLiveQuery(async () => {
    const threads = await db.threads.toArray();
    return sortThreadsForSidebar(threads);
  }, []);
}

export function useMessages(threadId: string | null) {
  return useLiveQuery(async () => {
    if (!threadId) return [];
    return db.messages
      .where('[threadId+createdAt]')
      .between([threadId, ''], [threadId, '\uffff'])
      .toArray();
  }, [threadId]);
}

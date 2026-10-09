import { useState, useCallback, useRef, useEffect } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AgentEvent, ChatMessage, Thread } from '@org/agent-models';
import { clampChatTitle } from '@/lib/thread-title';
import {
  db,
  getMessages,
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
import {
  readStoredComposerModel,
  resolveOllamaModel,
  writeStoredComposerModel,
} from '@/lib/ollama-models';

export type QueuedMessage = {
  content: string;
  options: ComposerOptions;
};

const defaultComposerOptions = (): ComposerOptions => ({
  streaming: true,
  webSearch: true,
  model: readStoredComposerModel(),
});

function toChatContext(
  messages: Awaited<ReturnType<typeof getMessages>>,
): ChatMessage[] {
  return messages.map((m) => {
    if (m.role === 'user') return { role: 'user', content: m.content };
    if (m.role === 'tool')
      return {
        role: 'tool',
        tool_call_id: m.toolCallId!,
        content: m.content,
      };
    return { role: 'assistant', content: m.content };
  });
}

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
      if (threadId) {
        void updateThread(threadId, { model });
      }
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
      { skipQueue }: { skipQueue?: boolean } = {},
    ) => {
      if (!threadId) return;

      if (chatStateRef.current.activeRun?.status === 'running') {
        if (!skipQueue) {
          setQueuedMessage({ content, options });
        }
        return;
      }

      const userMessage = {
        id: crypto.randomUUID(),
        threadId,
        runId: null,
        role: 'user' as const,
        content,
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
      });

      setChatState(initialChatState());

      const isFirstMessage = history.length <= 1;
      if (isFirstMessage) {
        enqueueTitle(threadId, content)
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
    async (content: string, options: Partial<ComposerOptions> = {}) => {
      const merged: ComposerOptions = {
        streaming: options.streaming ?? composerOptions.streaming,
        webSearch: options.webSearch ?? composerOptions.webSearch,
        model: resolveOllamaModel(options.model ?? composerOptions.model),
        thinking: options.thinking ?? composerOptions.thinking,
      };

      if (chatStateRef.current.activeRun?.status === 'running') {
        setQueuedMessage({ content, options: merged });
        return;
      }

      await startRunForMessages(content, merged);
    },
    [composerOptions, startRunForMessages],
  );

  const sendQueuedNow = useCallback(async () => {
    if (!queuedMessage) return;
    const { content, options } = queuedMessage;
    setQueuedMessage(null);
    await interruptActiveRun();
    await startRunForMessages(content, options, { skipQueue: true });
  }, [queuedMessage, interruptActiveRun, startRunForMessages]);

  const editQueuedMessage = useCallback((): string | null => {
    if (!queuedMessage) return null;
    const content = queuedMessage.content;
    setQueuedMessage(null);
    return content;
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
    });

    setChatState(initialChatState());
    subscribeToRun(runId);
  }, [threadId, composerOptions, subscribeToRun]);

  const editLastUserMessage = useCallback(
    async (messageId: string, newContent: string) => {
      if (!threadId) return;
      const trimmed = newContent.trim();
      if (!trimmed) return;

      if (chatStateRef.current.activeRun?.status === 'running') {
        await interruptActiveRun();
      }

      const history = await getMessages(threadId);
      let lastUserId: string | null = null;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'user') {
          lastUserId = history[i].id;
          break;
        }
      }
      if (lastUserId !== messageId) return;

      await updateMessageContent(messageId, trimmed);
      await deleteMessagesAfter(threadId, messageId);

      const remaining = await getMessages(threadId);
      const contextMessages = toChatContext(remaining);

      const runId = await startRun(threadId, contextMessages, {
        streaming: composerOptions.streaming,
        webSearch: composerOptions.webSearch,
        model: resolveOllamaModel(composerOptions.model),
        thinking: composerOptions.thinking,
      });

      setChatState(initialChatState());
      subscribeToRun(runId);
    },
    [threadId, composerOptions, subscribeToRun, interruptActiveRun],
  );

  useEffect(() => {
    const running = chatState.activeRun?.status === 'running';
    if (wasRunningRef.current && !running && queuedMessage) {
      const { content, options } = queuedMessage;
      setQueuedMessage(null);
      void startRunForMessages(content, options, { skipQueue: true });
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

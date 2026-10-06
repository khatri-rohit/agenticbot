import { useState, useCallback, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { AgentEvent, ChatMessage } from '@org/agent-models';
import { db, getMessages, addMessage, updateThread } from '../store/db';
import {
  initialChatState,
  reduceChatState,
  type ChatState,
} from '../store/chat-store';
import { startRun, subscribeRun, enqueueTitle, pollTitle } from '../api/agent-client';

/**
 * Hook for managing an active agent run.
 * Starts a run, subscribes to SSE events, reduces them into ChatState,
 * and persists durable state to IndexedDB.
 *
 * On the first message in a thread, also enqueues a title generation job
 * and polls until the title is ready, then updates the thread in IndexedDB.
 */
export function useAgentRun(threadId: string | null) {
  const [chatState, setChatState] = useState<ChatState>(initialChatState());
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const sendMessage = useCallback(
    async (content: string, options: { streaming?: boolean } = {}) => {
      if (!threadId) return;
      if (chatState.activeRun?.status === 'running') return;

      // 1. Persist the user message
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

      // 2. Build the message context from history
      const history = await getMessages(threadId);
      const contextMessages: ChatMessage[] = history.map((m) => {
        if (m.role === 'user') return { role: 'user', content: m.content };
        if (m.role === 'tool')
          return {
            role: 'tool',
            tool_call_id: m.toolCallId!,
            content: m.content,
          };
        return { role: 'assistant', content: m.content };
      });

      // 3. Start the run
      const runId = await startRun(threadId, contextMessages, {
        streaming: options.streaming ?? true,
      });

      // 4. Reset chat state for the new run
      setChatState(initialChatState());

      // 5. If this is the first message, generate a title asynchronously
      const isFirstMessage = history.length <= 1;
      if (isFirstMessage) {
        enqueueTitle(threadId, content)
          .then((jobId) => pollForTitle(jobId, threadId))
          .catch((err) => console.error('Title generation failed:', err));
      }

      // 6. Subscribe to SSE events — must process in order (async reducer + races
      //    otherwise drop run.completed and leave status stuck on "running").
      let currentState = initialChatState();
      let eventChain = Promise.resolve();
      unsubscribeRef.current?.();
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
    [threadId, chatState.activeRun?.status],
  );

  const disconnect = useCallback(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = null;
  }, []);

  return {
    chatState,
    sendMessage,
    disconnect,
  };
}

/**
 * Poll the title job until completed, then update the thread in IndexedDB.
 */
async function pollForTitle(jobId: string, threadId: string): Promise<void> {
  const MAX_POLLS = 30;
  const INTERVAL_MS = 2000;

  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
    const result = await pollTitle(jobId);

    if (result.status === 'completed') {
      await updateThread(threadId, { title: result.title });
      return;
    }
    if (result.status === 'failed') {
      console.error('Title generation failed for thread', threadId);
      return;
    }
    // pending — keep polling
  }
  console.warn('Title generation timed out for thread', threadId);
}

/**
 * Live query for threads (sidebar).
 */
export function useThreads() {
  return useLiveQuery(
    () => db.threads.orderBy('updatedAt').reverse().toArray(),
    [],
  );
}

/**
 * Live query for messages in a thread (conversation view).
 */
export function useMessages(threadId: string | null) {
  return useLiveQuery(async () => {
    if (!threadId) return [];
    return db.messages
      .where('[threadId+createdAt]')
      .between([threadId, ''], [threadId, '\uffff'])
      .toArray();
  }, [threadId]);
}
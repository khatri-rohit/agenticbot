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
  type MessageAttachment,
  type ThreadKind,
} from '@agent/agent-models';
import {
  readStoredComposerLocal,
  readStoredComposerModel,
  readStoredContextWindowMode,
  resolveOllamaModel,
  writeStoredComposerLocal,
  writeStoredComposerModel,
} from '@/features/composer/ollama-models';
import type { ComposerOptions } from '../../api/agent-client';
import { fetchThread } from '../../api/thread-client';
import {
  ensureThreadsLoaded,
  getThreadsSnapshot,
  subscribeThreads,
  updateThread,
} from '../threads/thread-cache';
import { setWorkspaceRoot } from '../threads/space-store';
import { initialChatState } from './chat-store';
import {
  createThreadSession,
  type ChoiceAnswer,
  type ThreadSession,
  type ThreadView,
} from './thread-session';

const EMPTY_VIEW: ThreadView = {
  messages: [],
  chat: initialChatState(),
  queued: null,
  starting: false,
};
const getEmptyView = () => EMPTY_VIEW;
const noSubscription = () => () => undefined;

const defaultComposerOptions = (): ComposerOptions => {
  const local = readStoredComposerLocal();
  return {
    webSearch: true,
    local,
    model: readStoredComposerModel(local),
    posture: 'agent',
    contextWindowMode: readStoredContextWindowMode(),
  };
};

/**
 * React adapter over one thread's session (see thread-session.ts) plus the
 * composer's options, which are UI preferences and live here.
 */
export function useAgentRun(threadId: string) {
  const [session, setSession] = useState<ThreadSession | null>(null);
  // Callbacks read the live session, including effects in the same commit.
  const sessionRef = useRef<ThreadSession | null>(null);
  const [composerOptions, setComposerOptions] = useState<ComposerOptions>(
    defaultComposerOptions,
  );
  const [threadKind, setThreadKind] = useState<ThreadKind>('home');
  const [isSubagentThread, setIsSubagentThread] = useState(false);

  useEffect(() => {
    const next = createThreadSession(threadId);
    sessionRef.current = next;
    setSession(next);
    return () => {
      next.dispose();
      if (sessionRef.current === next) sessionRef.current = null;
    };
  }, [threadId]);

  const view = useSyncExternalStore(
    session?.subscribe ?? noSubscription,
    session?.getSnapshot ?? getEmptyView,
    getEmptyView,
  );

  useEffect(() => {
    let cancelled = false;
    void fetchThread(threadId).then((thread) => {
      if (cancelled || !thread) return;
      const workspace = isWorkspaceKind(thread.kind);
      setThreadKind(workspace ? 'workspace' : 'home');
      setIsSubagentThread(thread.parentThreadId !== undefined);
      setWorkspaceRoot(workspace && thread.workspaceRoot ? thread.workspaceRoot : null);
      setComposerOptions((prev) => ({
        ...prev,
        model: resolveOllamaModel(thread.model, prev.local === true),
        contextWindowMode:
          thread.contextWindowMode ?? prev.contextWindowMode ?? 'default',
      }));
    });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  const setComposerOptionsPersisted = useCallback(
    (options: ComposerOptions) => {
      const local = options.local === true;
      const model = resolveOllamaModel(options.model, local);
      setComposerOptions({ ...options, local, model });
      writeStoredComposerLocal(local);
      writeStoredComposerModel(model, local);
      if (model) void updateThread(threadId, { model });
    },
    [threadId],
  );

  const sendMessage = useCallback(
    async (
      content: string,
      options: Partial<ComposerOptions> = {},
      attachments?: MessageAttachment[],
    ) => {
      const local = options.local ?? composerOptions.local === true;
      await sessionRef.current?.send(
        content,
        {
          webSearch: options.webSearch ?? composerOptions.webSearch,
          local,
          model: resolveOllamaModel(options.model ?? composerOptions.model, local),
          thinking: options.thinking ?? composerOptions.thinking,
          posture: normalizeRunPosture(options.posture ?? composerOptions.posture),
          ...(options.skills ? { skills: options.skills } : {}),
          contextWindowMode:
            options.contextWindowMode ?? composerOptions.contextWindowMode ?? 'default',
        },
        attachments,
      );
    },
    [composerOptions],
  );

  const editQueuedMessage = useCallback(() => {
    const queued = sessionRef.current?.takeQueued();
    if (!queued) return null;
    return {
      content: queued.content,
      attachments: queued.attachments,
      skills: queued.options.skills,
    };
  }, []);

  const retryLastResponse = useCallback(
    () => sessionRef.current?.retry(composerOptions),
    [composerOptions],
  );
  const editLastUserMessage = useCallback(
    (messageId: string, content: string) =>
      sessionRef.current?.edit(messageId, content, composerOptions),
    [composerOptions],
  );

  return {
    messages: view.messages,
    chatState: view.chat,
    queuedMessage: view.queued,
    composerOptions,
    setComposerOptions: setComposerOptionsPersisted,
    sendMessage,
    sendQueuedNow: () =>
      sessionRef.current?.sendQueuedNow(normalizeRunPosture(composerOptions.posture)),
    editQueuedMessage,
    retryLastResponse,
    editLastUserMessage,
    stopGeneration: () => sessionRef.current?.stop(),
    resolvePendingChoice: (choiceId: string, answer: ChoiceAnswer) =>
      sessionRef.current?.answerChoice(choiceId, answer) ?? Promise.resolve(),
    // Busy from the send through post-loop compaction, until run.settled.
    isRunning: view.starting || view.chat.activeRun !== null,
    threadKind,
    isSubagentThread,
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

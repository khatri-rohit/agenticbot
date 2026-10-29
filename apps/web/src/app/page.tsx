'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { MessageAttachment } from '@agent/agent-models';
import { ChatInput } from '../components/chat-input';
import { ChatShell } from '../components/chat-shell';
import {
  stashPendingMessage,
  type ComposerOptions,
} from '../features/agent/api/agent-client';
import {
  createThread,
  deleteThread,
} from '../features/agent/api/thread-client';
import { useThreads } from '../features/agent/hooks/use-agent-run';
import { refreshThreads } from '../features/agent/store/thread-cache';
import { toastError } from '@/hooks/use-toast';
import {
  readStoredComposerLocal,
  readStoredComposerModel,
  readStoredContextWindowMode,
  writeStoredComposerLocal,
  writeStoredComposerModel,
} from '@/lib/ollama-models';
import { clampChatTitle } from '@/lib/thread-title';
import { formatRelativeTime } from '../lib/format-relative-time';
import {
  folderNameFromRoot,
  ensureWorkspaceInOrder,
  setWorkspaceRoot,
  useAgentSpace,
} from '@/features/agent/store/space-store';

/** Must match ChatInput draft key for the home composer. */
const HOME_DRAFT_SCOPE = '__home__';

const defaultOptions = (webSearch: boolean): ComposerOptions => {
  const local = readStoredComposerLocal();
  return {
    webSearch,
    local,
    model: readStoredComposerModel(local),
    posture: 'agent',
    contextWindowMode: readStoredContextWindowMode(),
  };
};

function restoreHomeDraft(content: string, attachments?: MessageAttachment[]) {
  try {
    localStorage.setItem(
      `agent:composerDraft:${HOME_DRAFT_SCOPE}`,
      JSON.stringify({
        content,
        attachments: attachments ?? [],
      }),
    );
  } catch {
    /* quota / private mode */
  }
}

export default function HomePage() {
  const router = useRouter();
  const { workspaceRoot } = useAgentSpace();
  const bound = Boolean(workspaceRoot);
  const threads = useThreads();
  const [pendingContent, setPendingContent] = useState(false);
  /** Remount ChatInput after a failed send so it reloads the restored draft. */
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [composerOptions, setComposerOptions] = useState<ComposerOptions>(() =>
    defaultOptions(true),
  );

  const recentThreads = useMemo(() => {
    return (threads ?? [])
      .filter((t) => t.title !== 'New Chat')
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 5);
  }, [threads]);

  return (
    <ChatShell layout="home">
      <div className="flex w-full max-w-2xl flex-col gap-9">
        <div className="w-full space-y-2 text-center">
          <h1 className="type-hero-title text-foreground/95">
            {bound
              ? `Work in ${folderNameFromRoot(workspaceRoot)}`
              : 'Chat with your agent'}
          </h1>
          <p className="type-hero-sub mx-auto max-w-sm text-pretty">
            {bound
              ? 'Ask to find, edit, or build in this folder.'
              : 'Start a conversation, or pick a workspace in the composer.'}
          </p>
        </div>
        {recentThreads.length > 0 ? (
          <section aria-label="Recent threads" className="w-full">
            <p className="type-ui mb-2 font-medium text-muted-foreground">
              Recent
            </p>
            <ul className="flex flex-col gap-0.5">
              {recentThreads.map((thread) => (
                <li key={thread.id}>
                  <Link
                    href={`/chat/${thread.id}`}
                    className="flex items-center gap-3 rounded-md px-2.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/45 hover:text-foreground"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {clampChatTitle(thread.title)}
                    </span>
                    <span className="type-caption shrink-0 tabular-nums text-muted-foreground/60">
                      {formatRelativeTime(thread.updatedAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <ChatInput
          key={`${HOME_DRAFT_SCOPE}-${draftEpoch}`}
          draftScope={HOME_DRAFT_SCOPE}
          variant="hero"
          showWorkspacePicker
          showPostureChips={bound}
          onSend={async (content, options, attachments) => {
            setPendingContent(true);
            try {
              const thread = await createThread('New Chat', options.model, {
                kind: bound ? 'workspace' : 'home',
                ...(bound && workspaceRoot ? { workspaceRoot } : {}),
              });
              if (thread.workspaceRoot) {
                ensureWorkspaceInOrder(thread.workspaceRoot);
                setWorkspaceRoot(thread.workspaceRoot);
              }
              await refreshThreads();
              const stashed = stashPendingMessage({
                content,
                webSearch: options.webSearch,
                model: options.model,
                local: options.local,
                thinking: options.thinking,
                posture: bound
                  ? options.posture === 'ask'
                    ? 'ask'
                    : 'agent'
                  : undefined,
                attachments,
                ...(options.skills ? { skills: options.skills } : {}),
                ...(options.contextWindowMode
                  ? { contextWindowMode: options.contextWindowMode }
                  : {}),
              });
              if (!stashed) {
                await deleteThread(thread.id);
                await refreshThreads();
                setPendingContent(false);
                restoreHomeDraft(content, attachments);
                setDraftEpoch((n) => n + 1);
                toastError(
                  'Could not start the chat with those images. Try fewer or smaller ones.',
                  'Images too large to hand off',
                );
                return;
              }
              router.push(`/chat/${thread.id}`);
            } catch {
              setPendingContent(false);
              restoreHomeDraft(content, attachments);
              setDraftEpoch((n) => n + 1);
              toastError(
                'Could not create the chat. Your draft was restored - try again.',
                'Failed to start chat',
              );
            }
          }}
          isRunning={pendingContent}
          queuedMessage={null}
          onSendQueuedNow={() => undefined}
          onEditQueued={() => null}
          composerOptions={composerOptions}
          onComposerOptionsChange={(options) => {
            const local = options.local === true;
            setComposerOptions({ ...options, local });
            writeStoredComposerLocal(local);
            writeStoredComposerModel(options.model, local);
          }}
        />
      </div>
    </ChatShell>
  );
}

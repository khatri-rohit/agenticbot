'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { MessageAttachment } from '@org/agent-models';
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
import { refreshThreads } from '../features/agent/store/thread-cache';
import { toastError } from '@/hooks/use-toast';
import {
  readStoredComposerLocal,
  readStoredComposerModel,
  writeStoredComposerLocal,
  writeStoredComposerModel,
} from '@/lib/ollama-models';
import {
  folderNameFromRoot,
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
  };
};

function restoreHomeDraft(content: string, attachments?: MessageAttachment[]) {
  try {
    localStorage.setItem(
      `agenticbot:composerDraft:${HOME_DRAFT_SCOPE}`,
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
  const [pendingContent, setPendingContent] = useState(false);
  /** Remount ChatInput after a failed send so it reloads the restored draft. */
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [composerOptions, setComposerOptions] = useState<ComposerOptions>(() =>
    defaultOptions(true),
  );

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

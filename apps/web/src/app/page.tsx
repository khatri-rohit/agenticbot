'use client';

import { useEffect, useState } from 'react';
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
  readStoredComposerModel,
  writeStoredComposerModel,
} from '@/lib/ollama-models';
import {
  folderNameFromRoot,
  setWorkspaceRoot,
  useAgentSpace,
} from '@/features/agent/store/space-store';

/** Must match ChatInput draft key for the home composer. */
const HOME_DRAFT_SCOPE = '__home__';

const defaultOptions = (webSearch: boolean): ComposerOptions => ({
  streaming: true,
  webSearch,
  model: readStoredComposerModel(),
});

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
  const { space, workspaceRoot } = useAgentSpace();
  const [pendingContent, setPendingContent] = useState(false);
  /** Remount ChatInput after a failed send so it reloads the restored draft. */
  const [draftEpoch, setDraftEpoch] = useState(0);
  const [composerOptions, setComposerOptions] = useState<ComposerOptions>(() =>
    defaultOptions(true),
  );

  useEffect(() => {
    setComposerOptions((prev) => ({
      ...prev,
      webSearch: space !== 'coding',
    }));
  }, [space]);

  return (
    <ChatShell layout="home">
      <div className="flex w-full max-w-2xl flex-col gap-9">
        <div className="w-full space-y-2 text-center">
          <h1 className="type-hero-title text-foreground/95">
            {space === 'coding'
              ? workspaceRoot
                ? `Code in ${folderNameFromRoot(workspaceRoot)}`
                : 'Open a folder to code'
              : 'Research with your agent'}
          </h1>
          <p className="type-hero-sub mx-auto max-w-sm text-pretty">
            {space === 'coding'
              ? workspaceRoot
                ? 'Ask to find, edit, or build in this project.'
                : 'Use Open folder in the sidebar to pick a project, then start chatting.'
              : 'Ask a question to start a new thread.'}
          </p>
        </div>
        <ChatInput
          key={`${HOME_DRAFT_SCOPE}-${draftEpoch}`}
          draftScope={HOME_DRAFT_SCOPE}
          variant="hero"
          hideWebSearch={space === 'coding'}
          onSend={async (content, options, attachments) => {
            if (space === 'coding' && !workspaceRoot) {
              toastError(
                'Open a project folder in the sidebar first.',
                'No folder open',
              );
              return;
            }
            setPendingContent(true);
            try {
              const thread = await createThread('New Chat', options.model, {
                kind: space,
                ...(space === 'coding' && workspaceRoot
                  ? { workspaceRoot }
                  : {}),
              });
              if (thread.workspaceRoot) {
                setWorkspaceRoot(thread.workspaceRoot);
              }
              await refreshThreads();
              const stashed = stashPendingMessage({
                content,
                streaming: options.streaming,
                webSearch: space === 'coding' ? false : options.webSearch,
                model: options.model,
                thinking: options.thinking,
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
            setComposerOptions(options);
            writeStoredComposerModel(options.model);
          }}
        />
      </div>
    </ChatShell>
  );
}

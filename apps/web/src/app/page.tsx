'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChatInput } from '../components/chat-input';
import { ChatShell } from '../components/chat-shell';
import { createThread } from '../features/agent/store/db';
import {
  stashPendingMessage,
  type ComposerOptions,
} from '../features/agent/api/agent-client';
import {
  readStoredComposerModel,
  writeStoredComposerModel,
} from '@/lib/ollama-models';

const defaultOptions: ComposerOptions = {
  streaming: true,
  webSearch: true,
  model: readStoredComposerModel(),
};

export default function HomePage() {
  const router = useRouter();
  const [pendingContent, setPendingContent] = useState(false);
  const [composerOptions, setComposerOptions] =
    useState<ComposerOptions>(defaultOptions);

  const handleComposerOptionsChange = useCallback(
    (options: ComposerOptions) => {
      setComposerOptions(options);
      writeStoredComposerModel(options.model);
    },
    [],
  );

  const handleSend = useCallback(
    async (content: string, options: ComposerOptions) => {
      setPendingContent(true);
      const thread = await createThread('New Chat', options.model);
      stashPendingMessage({
        content,
        streaming: options.streaming,
        webSearch: options.webSearch,
        model: options.model,
        thinking: options.thinking,
      });
      router.push(`/chat/${thread.id}`);
    },
    [router],
  );

  return (
    <ChatShell layout="home">
      <div className="flex w-full max-w-2xl flex-col gap-9">
        <div className="w-full space-y-2 text-center">
          <h1 className="type-hero-title text-foreground/95">
            Research with your agent
          </h1>
          <p className="type-hero-sub mx-auto max-w-sm text-pretty">
            Ask a question to start a new thread.
          </p>
        </div>
        <ChatInput
          variant="hero"
          onSend={handleSend}
          isRunning={pendingContent}
          queuedMessage={null}
          onSendQueuedNow={() => undefined}
          onEditQueued={() => null}
          composerOptions={composerOptions}
          onComposerOptionsChange={handleComposerOptionsChange}
        />
      </div>
    </ChatShell>
  );
}

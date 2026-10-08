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

const MODEL = 'llama3.1:8b';

const defaultOptions: ComposerOptions = {
  streaming: true,
  webSearch: true,
};

export default function HomePage() {
  const router = useRouter();
  const [pendingContent, setPendingContent] = useState(false);
  const [composerOptions, setComposerOptions] =
    useState<ComposerOptions>(defaultOptions);

  const handleSend = useCallback(
    async (
      content: string,
      options: { streaming: boolean; webSearch: boolean },
    ) => {
      setPendingContent(true);
      const thread = await createThread('New Chat', MODEL);
      stashPendingMessage({
        content,
        streaming: options.streaming,
        webSearch: options.webSearch,
      });
      router.push(`/chat/${thread.id}`);
    },
    [router],
  );

  return (
    <ChatShell layout="home">
      <div className="flex w-full max-w-3xl flex-col items-center gap-10">
        <div className="space-y-1.5 text-center">
          <p className="text-base font-medium tracking-tight text-foreground/95">
            Research with your agent
          </p>
          <p className="text-[13px] text-muted-foreground">
            Ask a question to start a new thread.
          </p>
        </div>
        <ChatInput
          variant="hero"
          onSend={handleSend}
          isRunning={pendingContent}
          queuedMessage={null}
          onSendQueuedNow={() => {}}
          onEditQueued={() => null}
          composerOptions={composerOptions}
          onComposerOptionsChange={setComposerOptions}
        />
      </div>
    </ChatShell>
  );
}

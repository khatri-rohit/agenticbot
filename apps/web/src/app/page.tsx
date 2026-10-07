'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChatInput } from '../components/chat-input';
import { ChatShell } from '../components/chat-shell';
import { createThread } from '../features/agent/store/db';
import { stashPendingMessage } from '../features/agent/api/agent-client';

const MODEL = 'llama3.1:8b';

export default function HomePage() {
  const router = useRouter();
  const [pendingContent, setPendingContent] = useState(false);

  const handleSend = useCallback(
    async (content: string, options: { streaming: boolean }) => {
      setPendingContent(true);
      const thread = await createThread('New Chat', MODEL);
      stashPendingMessage({ content, streaming: options.streaming });
      router.push(`/chat/${thread.id}`);
    },
    [router],
  );

  return (
    <ChatShell layout="home">
      <div className="flex w-full max-w-3xl flex-col items-center gap-10">
        <div className="space-y-2 text-center">
          <p className="text-lg font-medium tracking-tight text-foreground">
            Research with your agent
          </p>
          <p className="text-sm text-muted-foreground">
            Ask a question to start a new thread.
          </p>
        </div>
        <ChatInput
          variant="hero"
          onSend={handleSend}
          disabled={pendingContent}
        />
      </div>
    </ChatShell>
  );
}

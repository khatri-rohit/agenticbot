'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ChatInput } from '../components/chat-input';
import { ChatShell, HomeHeader } from '../components/chat-shell';
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
    <ChatShell
      header={<HomeHeader />}
      footer={<ChatInput onSend={handleSend} disabled={pendingContent} />}
    >
      <div className="flex flex-1 flex-col items-center justify-center px-6">
        <p className="max-w-md text-center text-base text-muted-foreground">
          Ask a research question. Your thread is created when you send the
          first message.
        </p>
      </div>
    </ChatShell>
  );
}

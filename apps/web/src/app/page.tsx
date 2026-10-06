'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '../components/sidebar';
import { ChatInput } from '../components/chat-input';
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
    <div className="flex h-screen w-full bg-zinc-950 text-zinc-200">
      <Sidebar />
      <main className="flex flex-1 flex-col">
        <header className="border-b border-zinc-800 px-6 py-3">
          <h1 className="text-lg font-semibold text-zinc-300">
            New Conversation
          </h1>
        </header>
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-4">
          <h2 className="text-3xl font-semibold text-white">AgenticBot</h2>
          <p className="text-base text-zinc-500">
            Local-first AI agent with streaming chat
          </p>
        </div>
        <ChatInput onSend={handleSend} disabled={pendingContent} />
      </main>
    </div>
  );
}

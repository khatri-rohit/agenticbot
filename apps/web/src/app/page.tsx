'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { createThread } from '../features/agent/store/db';

const MODEL = 'llama3.1:8b';

export default function HomePage() {
  const router = useRouter();

  const handleNewChat = useCallback(async () => {
    const thread = await createThread('New Chat', MODEL);
    router.push(`/chat/${thread.id}`);
  }, [router]);

  return (
    <div className="flex h-screen w-full bg-zinc-950 text-zinc-200">
      <div className="flex flex-1 flex-col items-center justify-center gap-6">
        <h1 className="text-4xl font-semibold text-white">AgenticBot</h1>
        <p className="text-base text-zinc-500">
          Local-first AI agent with streaming chat
        </p>
        <button
          onClick={handleNewChat}
          className="rounded-lg bg-blue-600 px-6 py-3 text-sm font-medium text-white transition hover:bg-blue-700"
        >
          + New Chat
        </button>
      </div>
    </div>
  );
}
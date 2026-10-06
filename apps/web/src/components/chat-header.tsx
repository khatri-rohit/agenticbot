'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { Sparkles } from 'lucide-react';
import { db } from '../features/agent/store/db';

export function ChatHeader({ threadId }: { threadId: string }) {
  const thread = useLiveQuery(() => db.threads.get(threadId), [threadId]);

  const title = thread?.title ?? 'New Chat';
  const isPending = title === 'New Chat';

  return (
    <header className="flex items-center gap-2.5 border-b border-zinc-800/60 px-6 py-3.5">
      <Sparkles className="h-4 w-4 shrink-0 text-blue-400" />
      <h1 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
        {isPending ? (
          <>
            <span className="text-zinc-400">New Conversation</span>
            <span className="h-3.5 w-28 animate-pulse rounded bg-zinc-800" />
          </>
        ) : (
          title
        )}
      </h1>
    </header>
  );
}
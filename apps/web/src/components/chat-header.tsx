'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../features/agent/store/db';

export function ChatHeader({ threadId }: { threadId: string }) {
  const thread = useLiveQuery(() => db.threads.get(threadId), [threadId]);

  const title = thread?.title ?? 'New Chat';
  const isPending = title === 'New Chat';

  return (
    <header className="border-b border-zinc-800 px-6 py-3">
      <h1 className="flex items-center gap-2 text-lg font-semibold text-zinc-200">
        {isPending ? (
          <span className="flex items-center gap-2">
            <span>New Conversation</span>
            <span className="h-4 w-32 animate-pulse rounded bg-zinc-800" />
          </span>
        ) : (
          title
        )}
      </h1>
    </header>
  );
}
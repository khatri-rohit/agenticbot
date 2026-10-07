'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../features/agent/store/db';

export function ChatHeader({ threadId }: { threadId: string }) {
  const thread = useLiveQuery(() => db.threads.get(threadId), [threadId]);

  const title = thread?.title ?? 'New Chat';
  const isPending = title === 'New Chat';

  return (
    <header className="shrink-0 px-6 py-3">
      <h1 className="truncate text-sm font-medium text-muted-foreground">
        {isPending ? (
          <span className="inline-flex items-center gap-2">
            <span>Untitled</span>
            <span className="h-2.5 w-20 animate-pulse rounded-full bg-muted" />
          </span>
        ) : (
          <span className="text-foreground/90">{title}</span>
        )}
      </h1>
    </header>
  );
}

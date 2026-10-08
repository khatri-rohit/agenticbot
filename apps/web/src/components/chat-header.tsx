'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { clampChatTitle } from '@/lib/thread-title';
import { db } from '../features/agent/store/db';

export function ChatHeader({ threadId }: { threadId: string }) {
  const thread = useLiveQuery(() => db.threads.get(threadId), [threadId]);

  const rawTitle = thread?.title ?? 'New Chat';
  const isPending = rawTitle === 'New Chat';
  const title = isPending ? rawTitle : clampChatTitle(rawTitle);

  return (
    <header className="shrink-0 border-b border-border/30 px-6 py-2.5">
      <h1 className="type-ui truncate font-medium text-muted-foreground">
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

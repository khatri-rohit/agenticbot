'use client';

import { useEffect, useState } from 'react';
import { clampChatTitle } from '@/lib/thread-title';
import { fetchThread } from '../features/agent/api/thread-client';
import {
  getThreadsSnapshot,
  subscribeThreads,
} from '../features/agent/store/thread-cache';

export function ChatHeader({ threadId }: { threadId: string }) {
  const [title, setTitle] = useState('New Chat');

  useEffect(() => {
    let cancelled = false;

    const apply = (raw: string | undefined) => {
      if (cancelled || !raw) return;
      setTitle(raw);
    };

    void fetchThread(threadId).then((thread) => apply(thread?.title));

    const unsub = subscribeThreads(() => {
      const cached = getThreadsSnapshot().find((t) => t.id === threadId);
      apply(cached?.title);
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [threadId]);

  const isPending = title === 'New Chat';
  const display = isPending ? title : clampChatTitle(title);

  return (
    <header className="shrink-0 border-b border-border/30 px-6 py-2.5">
      <h1 className="type-ui truncate font-medium text-muted-foreground">
        {isPending ? (
          <span className="inline-flex items-center gap-2">
            <span>Untitled</span>
            <span className="h-2.5 w-20 animate-pulse rounded-full bg-muted" />
          </span>
        ) : (
          <span className="text-foreground/90">{display}</span>
        )}
      </h1>
    </header>
  );
}

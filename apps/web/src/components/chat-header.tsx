'use client';

import { useEffect, useState } from 'react';
import { type Thread } from '@agent/agent-models';
import { clampChatTitle } from '@/lib/thread-title';
import { fetchThread } from '../features/agent/api/thread-client';
import {
  getThreadsSnapshot,
  subscribeThreads,
} from '../features/agent/store/thread-cache';

export function ChatHeader({ threadId }: { threadId: string }) {
  const [thread, setThread] = useState<Thread | undefined>();

  useEffect(() => {
    let cancelled = false;

    const apply = (next: Thread | undefined) => {
      if (cancelled || !next) return;
      setThread(next);
    };

    void fetchThread(threadId).then(apply);

    const unsub = subscribeThreads(() => {
      apply(getThreadsSnapshot().find((item) => item.id === threadId));
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [threadId]);

  const title = thread?.title ?? 'New Chat';
  const isPending = title === 'New Chat';
  const display = isPending ? title : clampChatTitle(title);

  return (
    <header className="shrink-0 border-b border-border/40 px-5 py-3">
      <h1 className="truncate text-lg font-semibold leading-snug tracking-tight text-pretty text-foreground">
        {isPending ? (
          <span className="inline-flex items-center gap-2">
            <span className="text-muted-foreground">Untitled</span>
            <span className="h-3 w-24 animate-pulse rounded-full bg-muted" />
          </span>
        ) : (
          display
        )}
      </h1>
    </header>
  );
}

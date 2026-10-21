'use client';

import { useEffect, useState } from 'react';
import { isWorkspaceKind, type Thread } from '@agenticbot/agent-models';
import { clampChatTitle } from '@/lib/thread-title';
import { fetchThread } from '../features/agent/api/thread-client';
import {
  getThreadsSnapshot,
  subscribeThreads,
} from '../features/agent/store/thread-cache';
import { folderNameFromRoot } from '@/features/agent/store/space-store';

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
  const workspace = isWorkspaceKind(thread?.kind);
  const folder = folderNameFromRoot(thread?.workspaceRoot ?? null);
  const pathTitle =
    workspace && thread?.workspaceRoot ? thread.workspaceRoot : undefined;

  return (
    <header className="shrink-0 border-b border-border/40 px-5 py-2.5">
      <p
        className="type-caption mb-0.5 truncate tracking-[0.06em] text-muted-foreground/80 uppercase"
        title={pathTitle}
      >
        {workspace ? `Workspace · ${folder || 'folder'}` : 'Home'}
      </p>
      <h1 className="truncate text-[15px] font-semibold leading-snug tracking-tight text-pretty text-foreground">
        {isPending ? (
          <span className="inline-flex items-center gap-2">
            <span className="text-muted-foreground">Untitled</span>
            <span className="h-2.5 w-20 animate-pulse rounded-full bg-muted" />
          </span>
        ) : (
          display
        )}
      </h1>
    </header>
  );
}

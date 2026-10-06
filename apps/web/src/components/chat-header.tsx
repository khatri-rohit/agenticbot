'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../features/agent/store/db';
import { Separator } from './ui/separator';

export function ChatHeader({ threadId }: { threadId: string }) {
  const thread = useLiveQuery(() => db.threads.get(threadId), [threadId]);

  const title = thread?.title ?? 'New Chat';
  const isPending = title === 'New Chat';

  return (
    <header className="shrink-0">
      <div className="px-6 py-4">
        <h1 className="text-sm font-medium text-foreground">
          {isPending ? (
            <span className="flex items-center gap-3">
              <span className="text-muted-foreground">Untitled chat</span>
              <span className="h-3 w-24 animate-pulse rounded bg-muted" />
            </span>
          ) : (
            title
          )}
        </h1>
      </div>
      <Separator />
    </header>
  );
}

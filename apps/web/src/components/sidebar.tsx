'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Thread } from '@org/agent-models';
import { useThreads } from '../features/agent/hooks/use-agent-run';
import { deleteThread } from '../features/agent/store/db';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Separator } from './ui/separator';
import { cn } from '../lib/utils';

export function Sidebar() {
  const threads = useThreads();
  const pathname = usePathname();

  return (
    <aside className="flex h-full min-h-0 w-[260px] shrink-0 flex-col border-r border-border bg-background">
      <div className="p-3">
        <p className="px-2 pb-3 text-xs font-medium tracking-wide text-muted-foreground">
          AgenticBot
        </p>
        <Button
          variant="outline"
          className="w-full justify-start font-normal"
          asChild
        >
          <Link href="/">New chat</Link>
        </Button>
      </div>
      <Separator />
      <ScrollArea className="flex-1 px-2 py-2">
        {threads?.length === 0 ? (
          <p className="px-2 py-6 text-sm text-muted-foreground">
            No chats yet
          </p>
        ) : (
          <ul className="space-y-0.5">
            {threads?.map((thread) => (
              <ThreadItem
                key={thread.id}
                thread={thread}
                active={pathname === `/chat/${thread.id}`}
              />
            ))}
          </ul>
        )}
      </ScrollArea>
    </aside>
  );
}

function ThreadItem({ thread, active }: { thread: Thread; active: boolean }) {
  const isPending = thread.title === 'New Chat';

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await deleteThread(thread.id);
  };

  return (
    <li>
      <Link
        href={`/chat/${thread.id}`}
        className={cn(
          'group flex items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors',
          active
            ? 'bg-accent text-accent-foreground'
            : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
        )}
      >
        {isPending ? (
          <span className="h-4 flex-1 animate-pulse rounded bg-muted" />
        ) : (
          <span className="flex-1 truncate">{thread.title}</span>
        )}
        <button
          type="button"
          onClick={handleDelete}
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground opacity-0 transition hover:text-foreground group-hover:opacity-100"
          aria-label="Delete chat"
        >
          Delete
        </button>
      </Link>
    </li>
  );
}

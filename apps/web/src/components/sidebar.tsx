'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Plus } from 'lucide-react';
import type { Thread } from '@org/agent-models';
import { useThreads } from '../features/agent/hooks/use-agent-run';
import { deleteThread } from '../features/agent/store/db';
import { formatRelativeTime } from '../lib/format-relative-time';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { cn } from '../lib/utils';

export function Sidebar() {
  const threads = useThreads();
  const pathname = usePathname();

  return (
    <aside className="flex h-full min-h-0 w-[268px] shrink-0 flex-col border-r border-border/50 bg-sidebar text-sidebar-foreground">
      <div className="p-3 pt-4">
        <Button
          variant="outline"
          className="h-9 w-full justify-start gap-2 rounded-lg border-border/60 bg-transparent font-normal text-foreground shadow-none hover:bg-accent/50"
          asChild
        >
          <Link href="/">
            <Plus className="size-4 opacity-80" strokeWidth={2} />
            New chat
          </Link>
        </Button>
      </div>
      <ScrollArea className="flex-1 px-2 pb-3">
        {threads?.length === 0 ? (
          <p className="px-3 py-8 text-xs text-muted-foreground">
            No conversations yet
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
      <div className="border-t border-border/40 px-4 py-3">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground">
          AgenticBot
        </p>
      </div>
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
          'group flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] transition-colors',
          active
            ? 'bg-accent/80 text-foreground'
            : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
        )}
      >
        {isPending ? (
          <span className="h-4 flex-1 animate-pulse rounded bg-muted" />
        ) : (
          <span className="flex-1 truncate leading-snug">{thread.title}</span>
        )}
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70 group-hover:hidden">
          {formatRelativeTime(thread.updatedAt)}
        </span>
        <button
          type="button"
          onClick={handleDelete}
          className="hidden shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition hover:text-foreground group-hover:inline"
          aria-label="Delete chat"
        >
          Delete
        </button>
      </Link>
    </li>
  );
}

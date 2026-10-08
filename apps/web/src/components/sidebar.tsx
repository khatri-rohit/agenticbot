'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  MoreHorizontal,
  PanelLeft,
  PanelLeftClose,
  Pin,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import type { Thread } from '@org/agent-models';
import { CHAT_TITLE_MAX_WORDS, clampChatTitle } from '@/lib/thread-title';
import { useThreads } from '../features/agent/hooks/use-agent-run';
import { deleteThread, updateThread } from '../features/agent/store/db';
import { formatRelativeTime } from '../lib/format-relative-time';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { SidebarSettings } from '@/components/sidebar-settings';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type SidebarProps = {
  collapsed: boolean;
  onCollapse: () => void;
  onExpand: () => void;
};

export function Sidebar({ collapsed, onCollapse, onExpand }: SidebarProps) {
  const threads = useThreads();
  const pathname = usePathname();

  return (
    <aside className="flex h-full min-h-0 w-full min-w-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="shrink-0 px-2 pt-2">
        {collapsed ? (
          <div className="flex flex-col items-stretch gap-1">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onExpand}
                  aria-label="Expand sidebar"
                  className="group/expand flex h-9 w-full items-center justify-center overflow-hidden rounded-md text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <PanelLeft
                    className="size-[1.125rem] shrink-0 -translate-x-1 transition-transform duration-200 group-hover/expand:translate-x-0"
                    strokeWidth={1.75}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Open sidebar</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  href="/"
                  aria-label="New chat"
                  className="flex h-9 w-full items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <Plus className="size-[1.125rem]" strokeWidth={2} />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">New chat</TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <>
            <header className="flex items-center justify-between gap-2 px-1 pb-2">
              <Link
                href="/"
                className="type-ui truncate font-semibold tracking-tight text-foreground/95 hover:text-foreground"
              >
                AgenticBot
              </Link>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className="shrink-0 text-muted-foreground"
                    onClick={onCollapse}
                    aria-label="Close sidebar"
                  >
                    <PanelLeftClose className="size-4" strokeWidth={1.75} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="bottom">Close sidebar</TooltipContent>
              </Tooltip>
            </header>
            <Link
              href="/"
              className="type-ui mb-2 inline-flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground"
            >
              <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border/45 bg-background/40 text-foreground">
                <Plus className="size-4 opacity-90" strokeWidth={2} />
              </span>
              <span>New chat</span>
            </Link>
          </>
        )}
      </div>

      {!collapsed ? (
        <ScrollArea className="min-h-0 flex-1 px-2">
          {threads?.length === 0 ? (
            <p className="type-ui px-2 py-6 text-center text-muted-foreground">
              No conversations yet
            </p>
          ) : (
            <div className="pb-2">
              <p className="type-ui mb-1 px-2 text-[10px] font-medium tracking-wide text-muted-foreground/75 uppercase">
                Recent
              </p>
              <ul className="w-full min-w-0 space-y-0.5">
                {threads?.map((thread) => (
                  <ThreadItem
                    key={thread.id}
                    thread={thread}
                    active={pathname === `/chat/${thread.id}`}
                  />
                ))}
              </ul>
            </div>
          )}
        </ScrollArea>
      ) : (
        <div className="min-h-0 flex-1" aria-hidden />
      )}

      <Separator className="shrink-0 bg-border/40" />
      <footer className="shrink-0 p-2">
        <SidebarSettings collapsed={collapsed} />
      </footer>
    </aside>
  );
}

function ThreadItem({ thread, active }: { thread: Thread; active: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const isPending = thread.title === 'New Chat';
  const displayTitle = isPending ? '' : clampChatTitle(thread.title);
  const isPinned = Boolean(thread.pinned);

  const handleDelete = async () => {
    await deleteThread(thread.id);
    if (pathname === `/chat/${thread.id}`) {
      router.push('/');
    }
  };

  const handlePinToggle = async () => {
    await updateThread(thread.id, { pinned: !isPinned });
  };

  const handleRename = async () => {
    const next = window.prompt(
      `Rename chat (up to ${CHAT_TITLE_MAX_WORDS} words):`,
      displayTitle || thread.title,
    );
    if (next === null) return;
    const title = clampChatTitle(next);
    if (!title || title === 'New Chat') return;
    await updateThread(thread.id, { title });
  };

  return (
    <li className="w-full min-w-0">
      <div
        className={cn(
          'type-ui group relative flex w-full min-w-0 items-stretch rounded-md transition-colors',
          active
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-accent/55 hover:text-foreground',
        )}
      >
        <Link
          href={`/chat/${thread.id}`}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1.5 pl-2.5 pr-[4.25rem] outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          title={displayTitle || undefined}
        >
          {isPinned ? (
            <Pin
              className="size-3 shrink-0 rotate-45 text-muted-foreground/80"
              aria-hidden
            />
          ) : null}
          {isPending ? (
            <span className="h-4 min-w-0 flex-1 animate-pulse rounded bg-muted" />
          ) : (
            <span className="min-w-0 flex-1 truncate leading-snug">
              {displayTitle}
            </span>
          )}
        </Link>
        <span className="pointer-events-none absolute top-1/2 right-8 -translate-y-1/2 text-[10px] tabular-nums text-muted-foreground/70 transition-opacity group-hover:opacity-0 group-has-[[data-state=open]]:opacity-0">
          {formatRelativeTime(thread.updatedAt)}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="absolute top-1/2 right-0.5 z-10 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground/80 hover:bg-accent/90 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=open]:bg-accent/90 data-[state=open]:text-foreground"
              aria-label="Chat options"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
              }}
            >
              <MoreHorizontal className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom" className="w-40">
            <DropdownMenuItem onSelect={() => void handlePinToggle()}>
              <Pin className="size-4" />
              {isPinned ? 'Unpin' : 'Pin'}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => void handleRename()}
              disabled={isPending}
            >
              <Pencil className="size-4" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => void handleDelete()}
            >
              <Trash2 className="size-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}

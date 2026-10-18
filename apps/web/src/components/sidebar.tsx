'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  MoreHorizontal,
  PanelLeft,
  PanelLeftClose,
  Pin,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import type { Thread } from '@org/agent-models';
import {
  folderNameFromRoot,
  removeRecentFolder,
  sameWorkspaceRoot,
  setAgentSpace,
  setWorkspaceRoot,
  toggleFolderCollapsed,
  useAgentSpace,
} from '@/features/agent/store/space-store';
import { CHAT_TITLE_MAX_WORDS, clampChatTitle } from '@/lib/thread-title';
import { useThreads } from '../features/agent/hooks/use-agent-run';
import {
  deleteThread,
  patchThread,
  pickWorkspaceFolder,
} from '../features/agent/api/thread-client';
import { refreshThreads } from '../features/agent/store/thread-cache';
import { removeRecentThread } from '../features/agent/store/recent-threads-store';
import { formatRelativeTime } from '../lib/format-relative-time';
import { toastError } from '@/hooks/use-toast';
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

type FolderGroup = {
  root: string;
  name: string;
  threads: Thread[];
};

export function Sidebar({ collapsed, onCollapse, onExpand }: SidebarProps) {
  const threads = useThreads();
  const pathname = usePathname();
  const router = useRouter();
  const { space, workspaceRoot, recentFolders, collapsedFolders } =
    useAgentSpace();

  const researchThreads = useMemo(
    () =>
      (threads ?? []).filter(
        (thread) => (thread.kind ?? 'research') === 'research',
      ),
    [threads],
  );

  const codingGroups = useMemo(() => {
    const codingThreads = (threads ?? []).filter(
      (thread) => thread.kind === 'coding' && thread.workspaceRoot,
    );
    const byKey = new Map<string, FolderGroup>();

    const ensure = (root: string) => {
      const key = root.replace(/[\\/]+$/, '').toLowerCase();
      let group = byKey.get(key);
      if (!group) {
        group = {
          root: root.replace(/[\\/]+$/, ''),
          name: folderNameFromRoot(root),
          threads: [],
        };
        byKey.set(key, group);
      }
      return group;
    };

    for (const root of recentFolders) ensure(root);
    for (const thread of codingThreads) {
      if (!thread.workspaceRoot) continue;
      ensure(thread.workspaceRoot).threads.push(thread);
    }

    for (const group of byKey.values()) {
      group.threads.sort((a, b) => {
        const pin = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
        if (pin !== 0) return pin;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
    }

    return Array.from(byKey.values()).sort((a, b) => {
      const aActive = sameWorkspaceRoot(a.root, workspaceRoot);
      const bActive = sameWorkspaceRoot(b.root, workspaceRoot);
      if (aActive !== bActive) return aActive ? -1 : 1;
      const aTime = a.threads[0]?.updatedAt ?? '';
      const bTime = b.threads[0]?.updatedAt ?? '';
      if (aTime || bTime) return bTime.localeCompare(aTime);
      return a.name.localeCompare(b.name);
    });
  }, [threads, recentFolders, workspaceRoot]);

  const railBtn =
    'flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

  const openBlankForFolder = (root: string) => {
    setAgentSpace('coding');
    setWorkspaceRoot(root);
    router.push('/');
  };

  return (
    <aside
      className={cn(
        'flex h-full min-h-0 w-full min-w-0 flex-col bg-sidebar text-sidebar-foreground',
        collapsed && 'items-center',
      )}
    >
      {collapsed ? (
        <>
          <div className="flex w-12 shrink-0 flex-col items-center gap-1 pt-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onExpand}
                  aria-label="Expand sidebar"
                  className={railBtn}
                >
                  <PanelLeft className="size-4" strokeWidth={1.75} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">Open sidebar</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link href="/" aria-label="New chat" className={railBtn}>
                  <Plus className="size-4" strokeWidth={2} />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">New chat</TooltipContent>
            </Tooltip>
          </div>
          <div className="min-h-0 flex-1" aria-hidden />
          <footer className="flex w-12 shrink-0 flex-col items-center pb-2">
            <SidebarSettings collapsed />
          </footer>
        </>
      ) : (
        <>
          <div className="shrink-0 px-2 pt-2">
            <header className="flex items-center justify-between gap-2 px-1 pb-2.5">
              <Link
                href="/"
                className="type-ui truncate text-[13px] font-semibold tracking-tight text-foreground hover:text-foreground"
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
            <SpaceToggle />
            {space === 'research' ? (
              <Link
                href="/"
                className="type-ui mb-2 inline-flex w-full items-center gap-2 rounded-md px-1 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground"
              >
                <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border/45 bg-background/40 text-foreground">
                  <Plus className="size-4 opacity-90" strokeWidth={2} />
                </span>
                <span>New chat</span>
              </Link>
            ) : (
              <OpenFolderButton className="mb-2" />
            )}
          </div>

          <ScrollArea className="min-h-0 flex-1 px-2">
            {space === 'coding' ? (
              codingGroups.length === 0 ? (
                <p className="type-ui px-2 py-6 text-center text-muted-foreground">
                  Open a folder to start coding chats
                </p>
              ) : (
                <div className="space-y-2 pb-2">
                  {codingGroups.map((group) => {
                    const collapsedFolder = collapsedFolders.some((item) =>
                      sameWorkspaceRoot(item, group.root),
                    );
                    const activeFolder = sameWorkspaceRoot(
                      group.root,
                      workspaceRoot,
                    );
                    return (
                      <div key={group.root} className="min-w-0">
                        <div
                          className={cn(
                            'group/folder flex w-full min-w-0 items-center gap-0.5 rounded-md px-1 py-1.5',
                            activeFolder
                              ? 'bg-accent/70 text-foreground'
                              : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                          )}
                        >
                          <button
                            type="button"
                            className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-accent/80"
                            aria-label={
                              collapsedFolder
                                ? `Expand ${group.name}`
                                : `Collapse ${group.name}`
                            }
                            onClick={() => toggleFolderCollapsed(group.root)}
                          >
                            {collapsedFolder ? (
                              <ChevronRight className="size-3.5" />
                            ) : (
                              <ChevronDown className="size-3.5" />
                            )}
                          </button>
                          <button
                            type="button"
                            className="type-ui flex min-w-0 flex-1 items-center gap-1.5 truncate text-left text-base! font-medium"
                            title={group.root}
                            onClick={() => {
                              setWorkspaceRoot(group.root);
                              if (collapsedFolder) {
                                toggleFolderCollapsed(group.root);
                              }
                            }}
                          >
                            <FolderOpen
                              className="size-3.5 shrink-0 opacity-80"
                              strokeWidth={1.75}
                            />
                            <span className="truncate">{group.name}</span>
                          </button>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-80 hover:bg-accent/80 hover:text-foreground group-hover/folder:opacity-100"
                                aria-label={`New chat in ${group.name}`}
                                onClick={() => openBlankForFolder(group.root)}
                              >
                                <Plus className="size-3.5" strokeWidth={2} />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="right">
                              New chat in {group.name}
                            </TooltipContent>
                          </Tooltip>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 hover:bg-accent/80 hover:text-foreground group-hover/folder:opacity-100 data-[state=open]:opacity-100"
                                aria-label={`${group.name} options`}
                              >
                                <MoreHorizontal className="size-3.5" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44">
                              <DropdownMenuItem
                                onSelect={() => openBlankForFolder(group.root)}
                              >
                                <Plus className="size-4" />
                                New chat
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onSelect={() => setWorkspaceRoot(group.root)}
                              >
                                <FolderOpen className="size-4" />
                                Use this folder
                              </DropdownMenuItem>
                              {group.threads.length === 0 ? (
                                <>
                                  <DropdownMenuSeparator />
                                  <DropdownMenuItem
                                    variant="destructive"
                                    onSelect={() =>
                                      removeRecentFolder(group.root)
                                    }
                                  >
                                    <Trash2 className="size-4" />
                                    Remove from list
                                  </DropdownMenuItem>
                                </>
                              ) : null}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                        {!collapsedFolder ? (
                          group.threads.length === 0 ? (
                            <p className="type-ui px-3 py-2 pl-8 text-[11px] text-muted-foreground/80">
                              No chats yet
                            </p>
                          ) : (
                            <ul className="mt-0.5 w-full min-w-0 space-y-0.5 pl-3">
                              {group.threads.map((thread) => (
                                <ThreadItem
                                  key={thread.id}
                                  thread={thread}
                                  active={pathname === `/chat/${thread.id}`}
                                  dense
                                />
                              ))}
                            </ul>
                          )
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )
            ) : researchThreads.length === 0 ? (
              <p className="type-ui px-2 py-6 text-center text-muted-foreground">
                No conversations yet
              </p>
            ) : (
              <div className="pb-2">
                <p className="type-ui mb-1 px-2 text-[10px] font-medium tracking-wide text-muted-foreground/75 uppercase">
                  Recent
                </p>
                <ul className="w-full min-w-0 space-y-0.5">
                  {researchThreads.map((thread) => (
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

          <Separator className="shrink-0 bg-border/40" />
          <footer className="shrink-0 p-2">
            <SidebarSettings collapsed={false} />
          </footer>
        </>
      )}
    </aside>
  );
}

function SpaceToggle() {
  const { space } = useAgentSpace();
  return (
    <div className="mb-2 grid grid-cols-2 gap-0.5 rounded-md bg-muted/55 p-0.5">
      <button
        type="button"
        className={cn(
          'type-ui rounded-[5px] px-2 py-1.5 text-xs font-medium transition-colors',
          space === 'research'
            ? 'bg-background text-foreground shadow-[0_1px_2px_oklch(0_0_0/0.18)] ring-1 ring-border/35'
            : 'text-muted-foreground hover:text-foreground',
        )}
        onClick={() => setAgentSpace('research')}
      >
        Research
      </button>
      <button
        type="button"
        className={cn(
          'type-ui rounded-[5px] px-2 py-1.5 text-xs font-medium transition-colors',
          space === 'coding'
            ? 'bg-background text-foreground shadow-[0_1px_2px_oklch(0_0_0/0.18)] ring-1 ring-border/35'
            : 'text-muted-foreground hover:text-foreground',
        )}
        onClick={() => setAgentSpace('coding')}
      >
        Coding
      </button>
    </div>
  );
}

function OpenFolderButton({ className }: { className?: string }) {
  const { workspaceRoot } = useAgentSpace();
  const [picking, setPicking] = useState(false);
  const router = useRouter();

  const pick = async () => {
    if (picking) return;
    setPicking(true);
    try {
      const selected = await pickWorkspaceFolder(workspaceRoot);
      if (!selected) return;
      setWorkspaceRoot(selected);
      setAgentSpace('coding');
      router.push('/');
    } catch (error) {
      toastError(
        error instanceof Error
          ? error.message
          : 'Could not open the folder picker. The dialog runs on the API host — start @org/api on this machine and try again.',
        'Folder picker failed',
      );
    } finally {
      setPicking(false);
    }
  };

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      title="Opens a native folder dialog on the machine running the API"
      className={cn(
        'type-ui h-8 w-full justify-start gap-2 border-border/40 bg-background/50 text-xs font-medium text-foreground/90 hover:bg-accent/50',
        className,
      )}
      disabled={picking}
      onClick={() => void pick()}
    >
      <FolderOpen className="size-3.5 opacity-85" strokeWidth={1.75} />
      {picking ? 'Choose a folder…' : 'Open folder'}
    </Button>
  );
}

function ThreadItem({
  thread,
  active,
  dense = false,
}: {
  thread: Thread;
  active: boolean;
  dense?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const isPending = thread.title === 'New Chat';
  const displayTitle = isPending ? '' : clampChatTitle(thread.title);
  const isPinned = Boolean(thread.pinned);

  const handleDelete = async () => {
    await deleteThread(thread.id);
    removeRecentThread(thread.id);
    await refreshThreads();
    if (pathname === `/chat/${thread.id}`) {
      router.push('/');
    }
  };

  const handlePinToggle = async () => {
    await patchThread(thread.id, { pinned: !isPinned });
    await refreshThreads();
  };

  const handleRename = async () => {
    const next = window.prompt(
      `Rename chat (up to ${CHAT_TITLE_MAX_WORDS} words):`,
      displayTitle || thread.title,
    );
    if (next === null) return;
    const title = clampChatTitle(next);
    if (!title || title === 'New Chat') return;
    await patchThread(thread.id, { title });
    await refreshThreads();
  };

  return (
    <li className="w-full min-w-0">
      <div
        className={cn(
          'type-ui group relative flex w-full min-w-0 items-stretch rounded-md transition-colors',
          active
            ? 'bg-accent/55 text-foreground'
            : 'text-muted-foreground/80 hover:bg-accent/55 hover:text-foreground',
        )}
      >
        <Link
          href={`/chat/${thread.id}`}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            dense
              ? 'py-1 pl-2 pr-[4.25rem] text-sm'
              : 'py-1.5 pl-2.5 pr-[4.25rem]',
          )}
          title={displayTitle || undefined}
          onClick={() => {
            if (thread.kind === 'coding' && thread.workspaceRoot) {
              setWorkspaceRoot(thread.workspaceRoot);
              setAgentSpace('coding');
            }
          }}
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

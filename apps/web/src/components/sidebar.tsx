'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  GripVertical,
  MoreHorizontal,
  PanelLeft,
  PanelLeftClose,
  Pin,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { isWorkspaceKind, type Thread } from '@agent/agent-models';
import {
  folderNameFromRoot,
  reorderWorkspaces,
  sameWorkspaceRoot,
  setWorkspaceRoot,
  syncWorkspaceOrder,
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

/** First page of threads under Home or a workspace project. */
const SIDEBAR_THREAD_PAGE = 8;

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

function sortThreadsByRecency(threads: Thread[]): Thread[] {
  return [...threads].sort((a, b) => {
    const pin = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
    if (pin !== 0) return pin;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

export function Sidebar({ collapsed, onCollapse, onExpand }: SidebarProps) {
  const threads = useThreads();
  const pathname = usePathname();
  const router = useRouter();
  const { workspaceRoot, workspaceOrder, collapsedFolders } = useAgentSpace();
  const [dragRoot, setDragRoot] = useState<string | null>(null);
  const [dropTargetRoot, setDropTargetRoot] = useState<string | null>(null);

  const homeThreads = useMemo(
    () =>
      sortThreadsByRecency(
        (threads ?? []).filter((thread) => !isWorkspaceKind(thread.kind)),
      ),
    [threads],
  );

  const workspaceGroups = useMemo(() => {
    const workspaceThreads = (threads ?? []).filter(
      (thread) => isWorkspaceKind(thread.kind) && thread.workspaceRoot,
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

    // Only folders that already have threads — never seed empty "ghost" projects.
    for (const thread of workspaceThreads) {
      if (!thread.workspaceRoot) continue;
      ensure(thread.workspaceRoot).threads.push(thread);
    }

    for (const group of byKey.values()) {
      group.threads = sortThreadsByRecency(group.threads);
    }

    const orderIndex = new Map(
      workspaceOrder.map((root, index) => [
        root.replace(/[\\/]+$/, '').toLowerCase(),
        index,
      ]),
    );

    return Array.from(byKey.values()).sort((a, b) => {
      const aKey = a.root.replace(/[\\/]+$/, '').toLowerCase();
      const bKey = b.root.replace(/[\\/]+$/, '').toLowerCase();
      const aIndex = orderIndex.get(aKey);
      const bIndex = orderIndex.get(bKey);
      if (aIndex !== undefined && bIndex !== undefined) return aIndex - bIndex;
      if (aIndex !== undefined) return -1;
      if (bIndex !== undefined) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [threads, workspaceOrder]);

  // Drop empties from persisted order; append newly discovered projects at the end.
  const rootsWithThreads = useMemo(
    () => workspaceGroups.map((group) => group.root),
    [workspaceGroups],
  );
  useEffect(() => {
    syncWorkspaceOrder(rootsWithThreads);
  }, [rootsWithThreads]);

  const railBtn =
    'flex size-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

  const openBlankHome = () => {
    setWorkspaceRoot(null);
    router.push('/');
  };

  const openBlankForFolder = (root: string) => {
    setWorkspaceRoot(root);
    router.push('/');
  };

  const moveWorkspace = (fromRoot: string, toRoot: string) => {
    if (sameWorkspaceRoot(fromRoot, toRoot)) return;
    const roots = workspaceGroups.map((group) => group.root);
    const fromIndex = roots.findIndex((root) =>
      sameWorkspaceRoot(root, fromRoot),
    );
    const toIndex = roots.findIndex((root) => sameWorkspaceRoot(root, toRoot));
    if (fromIndex < 0 || toIndex < 0) return;
    const next = [...roots];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    reorderWorkspaces(next);
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
          <div className="flex w-full shrink-0 flex-col items-center gap-1 pt-2">
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
                <Link
                  href="/"
                  aria-label="New chat"
                  className={railBtn}
                  onClick={() => setWorkspaceRoot(null)}
                >
                  <Plus className="size-4" strokeWidth={2} />
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">New chat</TooltipContent>
            </Tooltip>
          </div>
          <div className="min-h-0 flex-1" aria-hidden />
          <footer className="flex w-full shrink-0 flex-col items-center pb-2">
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
                Personal Agent
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
            <div className="mb-2 flex items-center gap-1">
              <Link
                href="/"
                onClick={() => setWorkspaceRoot(null)}
                className="type-ui inline-flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent/55 hover:text-foreground"
              >
                <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border/45 bg-background/40 text-foreground">
                  <Plus className="size-4 opacity-90" strokeWidth={2} />
                </span>
                <span>New chat</span>
              </Link>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled
                    aria-disabled="true"
                    aria-label="Search coming soon"
                    className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground/70"
                  >
                    <Search className="size-4" strokeWidth={1.75} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  Search coming soon
                </TooltipContent>
              </Tooltip>
            </div>
            <OpenFolderButton className="mb-2" />
          </div>

          <ScrollArea className="min-h-0 flex-1 px-2">
            <div className="space-y-4 pb-2">
              <section>
                <div className="mb-1.5 flex items-center justify-between gap-1 px-2">
                  <p className="type-ui text-[10px] font-medium tracking-[0.08em] text-muted-foreground/80 uppercase">
                    Home
                  </p>
                  <button
                    type="button"
                    className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent/80 hover:text-foreground"
                    aria-label="New home chat"
                    onClick={openBlankHome}
                  >
                    <Plus className="size-3.5" strokeWidth={2} />
                  </button>
                </div>
                {homeThreads.length === 0 ? (
                  <p className="type-ui px-2 py-3 text-center text-muted-foreground/85">
                    No conversations yet
                  </p>
                ) : (
                  <PagedThreadList
                    threads={homeThreads}
                    pathname={pathname}
                    listKey="home"
                  />
                )}
              </section>

              <section>
                <p className="type-ui mb-1.5 px-2 text-[10px] font-medium tracking-[0.08em] text-muted-foreground/80 uppercase">
                  Workspaces
                </p>
                {workspaceGroups.length === 0 ? (
                  <p className="type-ui px-2 py-3 text-center text-muted-foreground/85">
                    Open a folder to start project chats
                  </p>
                ) : (
                  <div
                    className="space-y-2"
                    role="list"
                    aria-label="Workspace projects"
                  >
                    {workspaceGroups.map((group) => {
                      const collapsedFolder = collapsedFolders.some((item) =>
                        sameWorkspaceRoot(item, group.root),
                      );
                      const activeFolder = sameWorkspaceRoot(
                        group.root,
                        workspaceRoot,
                      );
                      const isDragging = sameWorkspaceRoot(
                        group.root,
                        dragRoot,
                      );
                      const isDropTarget =
                        !isDragging &&
                        sameWorkspaceRoot(group.root, dropTargetRoot);

                      return (
                        <div
                          key={group.root}
                          role="listitem"
                          className="min-w-0 rounded-md"
                        >
                          <div
                            className={cn(
                              'group/folder flex w-full min-w-0 items-center gap-0.5 rounded-md px-1 py-1.5 transition-[opacity,box-shadow]',
                              activeFolder
                                ? 'bg-accent/70 text-foreground'
                                : 'text-muted-foreground hover:bg-accent/40 hover:text-foreground',
                              isDragging && 'opacity-45',
                              isDropTarget &&
                                'ring-1 ring-primary/50 ring-offset-1 ring-offset-sidebar',
                            )}
                            draggable
                            onDragStart={(event) => {
                              setDragRoot(group.root);
                              event.dataTransfer.effectAllowed = 'move';
                              event.dataTransfer.setData(
                                'text/plain',
                                group.root,
                              );
                            }}
                            onDragOver={(event) => {
                              event.preventDefault();
                              event.dataTransfer.dropEffect = 'move';
                              if (
                                !sameWorkspaceRoot(group.root, dropTargetRoot)
                              ) {
                                setDropTargetRoot(group.root);
                              }
                            }}
                            onDragLeave={(event) => {
                              // Only clear when the pointer truly leaves the row,
                              // not when crossing into a child element.
                              const related = event.relatedTarget;
                              if (
                                sameWorkspaceRoot(group.root, dropTargetRoot) &&
                                !(related instanceof Node &&
                                  event.currentTarget.contains(related))
                              ) {
                                setDropTargetRoot(null);
                              }
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              const from =
                                event.dataTransfer.getData('text/plain') ||
                                dragRoot;
                              if (from) moveWorkspace(from, group.root);
                              setDragRoot(null);
                              setDropTargetRoot(null);
                            }}
                            onDragEnd={() => {
                              setDragRoot(null);
                              setDropTargetRoot(null);
                            }}
                          >
                            <span
                              className="flex size-6 shrink-0 cursor-grab items-center justify-center rounded-md text-muted-foreground/60 active:cursor-grabbing"
                              aria-hidden
                              title="Drag to reorder workspace"
                            >
                              <GripVertical className="size-3.5" />
                            </span>
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
                                  className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-accent/80 hover:text-foreground group-hover/folder:opacity-100"
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
                                  onSelect={() =>
                                    openBlankForFolder(group.root)
                                  }
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
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                          {!collapsedFolder ? (
                            <PagedThreadList
                              threads={group.threads}
                              pathname={pathname}
                              listKey={group.root}
                              dense
                              className="mt-0.5 pl-3"
                            />
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
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

function PagedThreadList({
  threads,
  pathname,
  listKey,
  dense = false,
  className,
}: {
  threads: Thread[];
  pathname: string;
  listKey: string;
  dense?: boolean;
  className?: string;
}) {
  const [pages, setPages] = useState(1);

  useEffect(() => {
    setPages(1);
  }, [listKey]);

  const limit = pages * SIDEBAR_THREAD_PAGE;
  const visible = threads.slice(0, limit);
  const remaining = threads.length - visible.length;

  return (
    <div className={cn('w-full min-w-0', className)}>
      <ul className="w-full min-w-0 space-y-0.5">
        {visible.map((thread) => (
          <ThreadItem
            key={thread.id}
            thread={thread}
            active={pathname === `/chat/${thread.id}`}
            dense={dense}
          />
        ))}
      </ul>
      {remaining > 0 ? (
        <button
          type="button"
          className="type-caption mt-1 flex w-full items-center justify-center rounded-md bg-muted/35 px-2 py-1.5 text-muted-foreground/85 transition-colors hover:bg-muted/55 hover:text-foreground"
          onClick={() => setPages((current) => current + 1)}
        >
          Show {Math.min(remaining, SIDEBAR_THREAD_PAGE)} more
          {remaining > SIDEBAR_THREAD_PAGE ? ` · ${remaining} left` : ''}
        </button>
      ) : null}
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
      router.push('/');
    } catch (error) {
      toastError(
        error instanceof Error
          ? error.message
          : 'Could not open the folder picker. The dialog runs on the API host — start @agent/api on this machine and try again.',
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
          'group relative flex w-full min-w-0 items-stretch rounded-md transition-colors',
          active
            ? 'bg-accent text-foreground shadow-[inset_2px_0_0_0_var(--primary)]'
            : 'text-muted-foreground/80 hover:bg-accent/45 hover:text-foreground',
        )}
      >
        <Link
          href={`/chat/${thread.id}`}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
            dense
              ? 'py-1 pl-2 pr-9 text-[13px]'
              : 'py-1.5 pl-2.5 pr-9 text-[13px]',
            active && 'font-medium text-foreground',
          )}
          title={displayTitle || undefined}
          onClick={() => {
            if (isWorkspaceKind(thread.kind) && thread.workspaceRoot) {
              setWorkspaceRoot(thread.workspaceRoot);
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
            <span className="min-w-0 max-w-[80%] flex-1 truncate leading-snug">
              {displayTitle}
            </span>
          )}
        </Link>
        <span
          className={cn(
            'type-caption pointer-events-none absolute top-1/2 right-8 -translate-y-1/2 tabular-nums text-muted-foreground/70 transition-opacity',
            'group-focus-within:opacity-100',
            active && 'opacity-100',
            'group-has-[[data-state=open]]:opacity-0',
          )}
        >
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

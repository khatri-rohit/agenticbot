'use client';

import { useEffect, useMemo, useRef } from 'react';
import type { Thread, ThreadMentionAttachment } from '@agent/agent-models';
import {
  isWorkspaceKind,
  MAX_THREAD_MENTIONS,
  sameWorkspaceRoot,
} from '@agent/agent-models';
import { folderNameFromRoot } from '@/features/agent/store/space-store';
import { cn } from '@/lib/utils';
import { X } from 'lucide-react';

export function rankMentionThreads(
  threads: Thread[],
  currentThreadId: string | undefined,
  currentWorkspaceRoot: string | null,
): Thread[] {
  const others = threads.filter((thread) => thread.id !== currentThreadId);
  const byUpdated = (a: Thread, b: Thread) =>
    b.updatedAt.localeCompare(a.updatedAt);
  const same = others
    .filter(
      (thread) =>
        isWorkspaceKind(thread.kind) &&
        sameWorkspaceRoot(thread.workspaceRoot, currentWorkspaceRoot),
    )
    .sort(byUpdated);
  const cross = others
    .filter(
      (thread) =>
        isWorkspaceKind(thread.kind) &&
        !sameWorkspaceRoot(thread.workspaceRoot, currentWorkspaceRoot),
    )
    .sort(byUpdated);
  const home = others
    .filter((thread) => !isWorkspaceKind(thread.kind))
    .sort(byUpdated);
  return [...same, ...cross, ...home];
}

export function threadToMention(thread: Thread): ThreadMentionAttachment {
  return {
    type: 'thread',
    id: crypto.randomUUID(),
    threadId: thread.id,
    title: thread.title,
    kind: isWorkspaceKind(thread.kind) ? 'workspace' : 'home',
    ...(thread.workspaceRoot ? { workspaceRoot: thread.workspaceRoot } : {}),
  };
}

export function mentionQueryAtCaret(
  value: string,
  caret: number,
): { start: number; query: string } | null {
  const before = value.slice(0, caret);
  const match = /@([^\s]*)$/.exec(before);
  if (!match) return null;
  return { start: before.lastIndexOf('@'), query: match[1] };
}

function sourceLabel(thread: Thread): string {
  if (isWorkspaceKind(thread.kind) && thread.workspaceRoot) {
    return folderNameFromRoot(thread.workspaceRoot);
  }
  return 'Home';
}

export function ThreadMentionChip({
  mention,
  selected = false,
  onSelect,
  onRemove,
}: {
  mention: ThreadMentionAttachment;
  selected?: boolean;
  onSelect?: () => void;
  onRemove?: () => void;
}) {
  const label = mention.workspaceRoot
    ? folderNameFromRoot(mention.workspaceRoot)
    : 'Home';
  return (
    <span
      className={cn(
        'inline-flex max-w-[16rem] items-center gap-1 rounded-md py-0.5 pl-2 pr-1 text-xs ring-1',
        selected
          ? 'bg-primary/15 text-foreground ring-primary/45'
          : 'bg-muted/80 text-foreground/90 ring-border/50',
      )}
    >
      <button
        type="button"
        className="min-w-0 truncate text-left"
        onClick={onSelect}
        aria-pressed={selected}
        title={`${mention.title} · ${label}`}
      >
        {mention.title}
      </button>
      {onRemove ? (
        <button
          type="button"
          className="rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
          aria-label={`Remove ${mention.title}`}
          onClick={onRemove}
        >
          <X className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

export function ThreadMentionPicker({
  threads,
  query,
  activeIndex,
  onActiveIndexChange,
  selectedIds,
  onPick,
}: {
  threads: Thread[];
  query: string;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  selectedIds: Set<string>;
  onPick: (thread: Thread) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return threads;
    return threads.filter((thread) => {
      const title = thread.title.toLowerCase();
      const folder = thread.workspaceRoot
        ? folderNameFromRoot(thread.workspaceRoot).toLowerCase()
        : 'home';
      return title.includes(needle) || folder.includes(needle);
    });
  }, [threads, query]);

  useEffect(() => {
    const node = listRef.current?.querySelector('[data-active="true"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, filtered.length]);

  const atCap = selectedIds.size >= MAX_THREAD_MENTIONS;

  return (
    <div
      className="mb-1.5 w-full overflow-hidden rounded-xl bg-popover ring-1 ring-border/50"
      role="listbox"
      aria-label="Attach a thread"
    >
      <div
        ref={listRef}
        className="h-[16.25rem] overflow-y-auto py-1"
      >
        {filtered.length === 0 ? (
          <p className="px-3 py-6 text-center text-sm text-muted-foreground">
            No matching threads
          </p>
        ) : (
          filtered.map((thread, index) => {
            const active = index === activeIndex;
            const already = selectedIds.has(thread.id);
            const disabled = already || (atCap && !already);
            return (
              <button
                key={thread.id}
                type="button"
                role="option"
                aria-selected={active}
                data-active={active ? 'true' : 'false'}
                disabled={disabled}
                className={cn(
                  'flex h-10 w-full items-center gap-3 px-3 text-left text-sm',
                  active && 'bg-accent/80',
                  disabled && 'opacity-50',
                )}
                onMouseEnter={() => onActiveIndexChange(index)}
                onClick={() => {
                  if (!disabled) onPick(thread);
                }}
              >
                <span className="min-w-0 flex-1 truncate font-medium">
                  {thread.title}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {already ? 'Added' : sourceLabel(thread)}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

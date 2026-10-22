'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Circle, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { clampChatTitle } from '@/lib/thread-title';
import { formatRelativeTime } from '@/lib/format-relative-time';
import {
  ensureThreadsLoaded,
  getThreadsSnapshot,
} from '@/features/agent/store/thread-cache';
import {
  HOME_RECENT_ID,
  MAX_RECENT_THREADS,
  getRecentThreadIds,
  removeRecentThread,
  touchRecentThread,
} from '@/features/agent/store/recent-threads-store';
import { setWorkspaceRoot } from '@/features/agent/store/space-store';
import { isWorkspaceKind } from '@agent/agent-models';

type SwitcherEntry = {
  id: string;
  title: string;
  updatedAt: string | null;
  kind: 'home' | 'thread';
};

/** Gates type-to-focus while the picker is open. */
let switcherOpen = false;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.isContentEditable;
}

function homeEntry(): SwitcherEntry {
  return {
    id: HOME_RECENT_ID,
    title: 'New Chat',
    updatedAt: null,
    kind: 'home',
  };
}

function buildEntries(): SwitcherEntry[] {
  const byId = new Map(getThreadsSnapshot().map((t) => [t.id, t]));
  const entries: SwitcherEntry[] = [];

  for (const id of getRecentThreadIds()) {
    if (id === HOME_RECENT_ID) {
      entries.push(homeEntry());
    } else {
      const thread = byId.get(id);
      if (!thread) {
        removeRecentThread(id);
        continue;
      }
      entries.push({
        id: thread.id,
        title:
          thread.title === 'New Chat'
            ? 'New Chat'
            : clampChatTitle(thread.title),
        updatedAt: thread.updatedAt,
        kind: 'thread',
      });
    }
    if (entries.length >= MAX_RECENT_THREADS) break;
  }

  // Always offer New Chat / draft, even if home was never visited.
  if (!entries.some((e) => e.id === HOME_RECENT_ID)) {
    if (entries.length >= MAX_RECENT_THREADS) entries.pop();
    entries.push(homeEntry());
  }

  return entries;
}

function syncSpaceForThread(threadId: string): void {
  const thread = getThreadsSnapshot().find((t) => t.id === threadId);
  if (thread && isWorkspaceKind(thread.kind) && thread.workspaceRoot) {
    setWorkspaceRoot(thread.workspaceRoot);
  } else {
    setWorkspaceRoot(null);
  }
}

/**
 * MRU thread switcher (Ctrl+`).
 * Hold Ctrl and press ` or Tab to cycle; release Ctrl to navigate.
 */
export function RecentThreadsSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [entries, setEntries] = useState<SwitcherEntry[]>([]);
  const openRef = useRef(false);
  const selectedRef = useRef(0);
  const entriesRef = useRef<SwitcherEntry[]>([]);

  openRef.current = open;
  switcherOpen = open;
  selectedRef.current = selectedIndex;
  entriesRef.current = entries;

  useEffect(() => {
    if (pathname === '/') {
      touchRecentThread(HOME_RECENT_ID);
      return;
    }
    const match = /^\/chat\/([^/]+)/.exec(pathname);
    if (match?.[1]) touchRecentThread(match[1]);
  }, [pathname]);

  const selectIndex = useCallback((index: number) => {
    selectedRef.current = index;
    setSelectedIndex(index);
  }, []);

  const navigateTo = useCallback(
    (id: string) => {
      setOpen(false);
      switcherOpen = false;
      if (id === HOME_RECENT_ID) {
        if (pathname !== '/') router.push('/');
        return;
      }
      syncSpaceForThread(id);
      if (pathname !== `/chat/${id}`) router.push(`/chat/${id}`);
    },
    [pathname, router],
  );

  const openSwitcher = useCallback(() => {
    ensureThreadsLoaded();
    const next = buildEntries();
    if (next.length === 0) return;
    entriesRef.current = next;
    setEntries(next);
    // First open selects the previous item (index 1), like Alt+Tab.
    const initial = next.length > 1 ? 1 : 0;
    selectIndex(initial);
    setOpen(true);
  }, [selectIndex]);

  const advance = useCallback(
    (delta: number) => {
      const list = entriesRef.current;
      if (list.length === 0) return;
      const next =
        (selectedRef.current + delta + list.length * 10) % list.length;
      selectIndex(next);
    },
    [selectIndex],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Spec: Control+`, not Cmd+` (Mac Command is reserved for other UX).
      const ctrl = e.ctrlKey;
      const isBackquote =
        e.code === 'Backquote' || e.key === '`' || e.key === '~';

      if (openRef.current) {
        if (e.key === 'Escape') {
          e.preventDefault();
          switcherOpen = false;
          setOpen(false);
          return;
        }
        if (e.key === 'Tab' || (ctrl && isBackquote)) {
          e.preventDefault();
          advance(e.shiftKey ? -1 : 1);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          const entry = entriesRef.current[selectedRef.current];
          if (entry) navigateTo(entry.id);
          return;
        }
        return;
      }

      if (ctrl && isBackquote && !e.altKey && !e.metaKey) {
        e.preventDefault();
        openSwitcher();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (!openRef.current) return;
      if (e.key !== 'Control') return;
      const entry = entriesRef.current[selectedRef.current];
      if (entry) navigateTo(entry.id);
      else setOpen(false);
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, [advance, navigateTo, openSwitcher]);

  if (!open || entries.length === 0) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[18vh]"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) {
          switcherOpen = false;
          setOpen(false);
        }
      }}
    >
      <div
        role="listbox"
        aria-label="Recently viewed"
        className="w-full max-w-md overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/10"
      >
        <div className="px-3 pt-2.5 pb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground">
          Recently Viewed
        </div>
        <ul className="max-h-[min(420px,60vh)] overflow-y-auto px-1.5 pb-1.5">
          {entries.map((entry, index) => {
            const selected = index === selectedIndex;
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none',
                    selected
                      ? 'bg-accent text-foreground'
                      : 'text-foreground/90 hover:bg-accent/60',
                  )}
                  onMouseEnter={() => selectIndex(index)}
                  onClick={() => navigateTo(entry.id)}
                >
                  {entry.kind === 'home' ? (
                    <Circle
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  ) : (
                    <MessageSquare
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate">{entry.title}</span>
                  {entry.updatedAt ? (
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {formatRelativeTime(entry.updatedAt)}
                    </span>
                  ) : null}
                  <span className="shrink-0 text-[11px] text-muted-foreground/70">
                    Agent
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** True when a printable character should route into the chat composer. */
export function isTypeToFocusKey(e: KeyboardEvent): boolean {
  if (switcherOpen) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.isComposing) return false;
  if (e.key.length !== 1) return false;
  if (isEditableTarget(e.target)) return false;
  const active = document.activeElement;
  if (
    active instanceof HTMLElement &&
    active !== document.body &&
    isEditableTarget(active)
  ) {
    return false;
  }
  return true;
}

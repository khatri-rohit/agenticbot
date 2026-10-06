'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Thread } from '@org/agent-models';
import { useThreads } from '../features/agent/hooks/use-agent-run';
import { deleteThread } from '../features/agent/store/db';

export function Sidebar() {
  const threads = useThreads();
  const pathname = usePathname();

  return (
    <aside className="flex w-64 min-w-64 flex-col border-r border-zinc-800 bg-zinc-950 p-3">
      <Link
        href="/"
        className={`mb-3 rounded-lg px-4 py-2.5 text-center text-sm font-medium transition ${
          pathname === '/'
            ? 'bg-blue-700 text-white'
            : 'bg-blue-600 text-white hover:bg-blue-700'
        }`}
      >
        + New Chat
      </Link>
      <div className="flex-1 overflow-y-auto">
        {threads?.map((thread) => (
          <ThreadItem
            key={thread.id}
            thread={thread}
            active={pathname === `/chat/${thread.id}`}
          />
        ))}
      </div>
    </aside>
  );
}

function ThreadItem({ thread, active }: { thread: Thread; active: boolean }) {
  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    await deleteThread(thread.id);
  };

  const isPending = thread.title === 'New Chat';

  return (
    <Link
      href={`/chat/${thread.id}`}
      className={`mb-0.5 flex items-center justify-between rounded-md px-3 py-2 text-sm transition ${
        active
          ? 'bg-zinc-800 text-white'
          : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
      }`}
    >
      {isPending ? (
        <span className="flex flex-1 items-center gap-2">
          <span className="h-3.5 w-3/4 animate-pulse rounded bg-zinc-800" />
        </span>
      ) : (
        <span className="flex-1 truncate">{thread.title}</span>
      )}
      <button
        onClick={handleDelete}
        className="ml-2 text-zinc-600 hover:text-red-400"
        aria-label="Delete thread"
      >
        ×
      </button>
    </Link>
  );
}
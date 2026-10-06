'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Plus, MessageSquare, Trash2, Bot } from 'lucide-react';
import type { Thread } from '@org/agent-models';
import { useThreads } from '../features/agent/hooks/use-agent-run';
import { deleteThread } from '../features/agent/store/db';

export function Sidebar() {
  const threads = useThreads();
  const pathname = usePathname();

  return (
    <aside className="flex w-72 min-w-72 flex-col border-r border-zinc-800/60 bg-zinc-900/50">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600">
          <Bot className="h-5 w-5 text-white" />
        </div>
        <span className="text-sm font-semibold text-zinc-200">AgenticBot</span>
      </div>

      {/* New Chat */}
      <div className="px-3 pb-2">
        <Link
          href="/"
          className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
            pathname === '/'
              ? 'bg-zinc-800 text-white'
              : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
          }`}
        >
          <Plus className="h-4 w-4" />
          New Chat
        </Link>
      </div>

      {/* Thread list */}
      <div className="flex-1 overflow-y-auto px-2 pb-2">
        <div className="px-2 py-2 text-xs font-medium uppercase tracking-wider text-zinc-600">
          Conversations
        </div>
        {threads?.length === 0 && (
          <div className="px-3 py-4 text-sm text-zinc-600">No conversations yet</div>
        )}
        {threads?.map((thread) => (
          <ThreadItem
            key={thread.id}
            thread={thread}
            active={pathname === `/chat/${thread.id}`}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="border-t border-zinc-800/60 px-4 py-3">
        <div className="flex items-center gap-2 text-xs text-zinc-600">
          <span className="h-2 w-2 rounded-full bg-green-500" />
          <span>Local · Ollama</span>
        </div>
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
      className={`group mb-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm transition ${
        active
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-400 hover:bg-zinc-800/40 hover:text-zinc-200'
      }`}
    >
      <MessageSquare className="h-4 w-4 shrink-0 opacity-50" />

      {isPending ? (
        <span className="h-3.5 flex-1 animate-pulse rounded bg-zinc-800" />
      ) : (
        <span className="flex-1 truncate">{thread.title}</span>
      )}

      <button
        onClick={handleDelete}
        className="ml-auto text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:text-red-400"
        aria-label="Delete thread"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </Link>
  );
}
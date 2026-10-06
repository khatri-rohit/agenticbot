'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Bot, Sparkles } from 'lucide-react';
import { Sidebar } from '../components/sidebar';
import { ChatInput } from '../components/chat-input';
import { createThread } from '../features/agent/store/db';
import { stashPendingMessage } from '../features/agent/api/agent-client';

const MODEL = 'llama3.1:8b';

export default function HomePage() {
  const router = useRouter();
  const [pendingContent, setPendingContent] = useState(false);

  const handleSend = useCallback(
    async (content: string, options: { streaming: boolean }) => {
      setPendingContent(true);
      const thread = await createThread('New Chat', MODEL);
      stashPendingMessage({ content, streaming: options.streaming });
      router.push(`/chat/${thread.id}`);
    },
    [router],
  );

  return (
    <div className="flex h-screen w-full bg-zinc-950 text-zinc-200">
      <Sidebar />
      <main className="flex flex-1 flex-col">
        <header className="flex items-center gap-2.5 border-b border-zinc-800/60 px-6 py-3.5">
          <Sparkles className="h-4 w-4 text-blue-400" />
          <h1 className="text-sm font-medium text-zinc-400">New Conversation</h1>
        </header>

        {/* Empty state */}
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col items-center justify-center gap-6 px-6">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 shadow-lg">
            <Bot className="h-8 w-8 text-white" />
          </div>
          <div className="text-center">
            <h2 className="text-2xl font-semibold text-zinc-100">
              Welcome to AgenticBot
            </h2>
            <p className="mt-2 text-sm text-zinc-500">
              Local-first AI agent with streaming chat, web search, and research tools
            </p>
          </div>

          {/* Suggested prompts */}
          <div className="grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => {
                  setPendingContent(true);
                  createThread('New Chat', MODEL).then((thread) => {
                    stashPendingMessage({ content: s, streaming: true });
                    router.push(`/chat/${thread.id}`);
                  });
                }}
                disabled={pendingContent}
                className="rounded-xl border border-zinc-800 bg-zinc-900/40 px-4 py-3 text-left text-sm text-zinc-400 transition hover:border-zinc-700 hover:text-zinc-200 disabled:opacity-50"
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <ChatInput onSend={handleSend} disabled={pendingContent} />
      </main>
    </div>
  );
}

const SUGGESTIONS = [
  'Research the latest advances in AI agents',
  'Explain how RAG pipelines work',
  'Find recent papers on multi-modal LLMs',
  'Compare LangGraph vs OpenAI Agents SDK',
];
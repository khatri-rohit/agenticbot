'use client';

import { use, useEffect, useRef } from 'react';
import { Sidebar } from '../../../components/sidebar';
import { ChatHeader } from '../../../components/chat-header';
import { MessageList } from '../../../components/message-list';
import { ChatInput } from '../../../components/chat-input';
import { useMessages, useAgentRun } from '../../../features/agent/hooks/use-agent-run';

const PENDING_MSG_KEY = 'agenticbot:pendingMessage';

export default function ChatThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = use(params);
  const messages = useMessages(threadId);
  const { chatState, sendMessage } = useAgentRun(threadId);
  const sentPendingRef = useRef(false);

  const isRunning = chatState.activeRun?.status === 'running';

  /**
   * On mount: if we were redirected from the home page with a pending
   * message (stored in sessionStorage), send it immediately.
   */
  useEffect(() => {
    if (sentPendingRef.current) return;
    const raw = sessionStorage.getItem(PENDING_MSG_KEY);
    if (!raw) return;

    sessionStorage.removeItem(PENDING_MSG_KEY);
    sentPendingRef.current = true;

    const { content, streaming } = JSON.parse(raw) as {
      content: string;
      streaming: boolean;
    };
    void sendMessage(content, { streaming });
  }, [sendMessage]);

  return (
    <div className="flex h-screen w-full bg-zinc-950 text-zinc-200">
      <Sidebar />
      <main className="flex flex-1 flex-col">
        <ChatHeader threadId={threadId} />
        <MessageList messages={messages} chatState={chatState} />
        <ChatInput onSend={sendMessage} disabled={isRunning} />
      </main>
    </div>
  );
}
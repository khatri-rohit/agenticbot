'use client';

import { use, useEffect, useRef } from 'react';
import { Sidebar } from '../../../components/sidebar';
import { ChatHeader } from '../../../components/chat-header';
import { MessageList } from '../../../components/message-list';
import { ChatInput } from '../../../components/chat-input';
import { useMessages, useAgentRun } from '../../../features/agent/hooks/use-agent-run';
import { takePendingMessage } from '../../../features/agent/api/agent-client';

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

  useEffect(() => {
    if (sentPendingRef.current) return;
    const pending = takePendingMessage();
    if (!pending) return;
    sentPendingRef.current = true;
    void sendMessage(pending.content, { streaming: pending.streaming });
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
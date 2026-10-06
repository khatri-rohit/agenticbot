'use client';

import { use } from 'react';
import { Sidebar } from '../../../components/sidebar';
import { ChatHeader } from '../../../components/chat-header';
import { MessageList } from '../../../components/message-list';
import { ChatInput } from '../../../components/chat-input';
import { useMessages, useAgentRun } from '../../../features/agent/hooks/use-agent-run';

export default function ChatThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = use(params);
  const messages = useMessages(threadId);
  const { chatState, sendMessage } = useAgentRun(threadId);

  const isRunning = chatState.activeRun?.status === 'running';

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
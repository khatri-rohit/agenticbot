'use client';

import { use, useEffect, useRef } from 'react';
import { ChatHeader } from '../../../components/chat-header';
import { MessageList } from '../../../components/message-list';
import { ChatInput } from '../../../components/chat-input';
import { ChatShell } from '../../../components/chat-shell';
import {
  useMessages,
  useAgentRun,
} from '../../../features/agent/hooks/use-agent-run';
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
    <ChatShell
      header={<ChatHeader threadId={threadId} />}
      footer={<ChatInput onSend={sendMessage} disabled={isRunning} />}
    >
      <MessageList messages={messages} chatState={chatState} />
    </ChatShell>
  );
}

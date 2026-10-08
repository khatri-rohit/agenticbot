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
  const {
    chatState,
    sendMessage,
    sendQueuedNow,
    editQueuedMessage,
    queuedMessage,
    composerOptions,
    setComposerOptions,
    isRunning,
    retryLastResponse,
  } = useAgentRun(threadId);
  const sentPendingRef = useRef(false);

  useEffect(() => {
    if (sentPendingRef.current) return;
    const pending = takePendingMessage();
    if (!pending) return;
    sentPendingRef.current = true;
    setComposerOptions({
      streaming: pending.streaming,
      webSearch: pending.webSearch ?? true,
    });
    void sendMessage(pending.content, {
      streaming: pending.streaming,
      webSearch: pending.webSearch ?? true,
    });
  }, [sendMessage, setComposerOptions]);

  return (
    <ChatShell
      header={<ChatHeader threadId={threadId} />}
      footer={
        <ChatInput
          onSend={sendMessage}
          isRunning={isRunning}
          queuedMessage={queuedMessage}
          onSendQueuedNow={() => void sendQueuedNow()}
          onEditQueued={editQueuedMessage}
          composerOptions={composerOptions}
          onComposerOptionsChange={setComposerOptions}
        />
      }
    >
      <MessageList
        messages={messages}
        chatState={chatState}
        isRunning={isRunning}
        onRetryLastResponse={() => retryLastResponse()}
      />
    </ChatShell>
  );
}

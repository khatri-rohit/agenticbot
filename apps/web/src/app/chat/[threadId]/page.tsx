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
import { resolveOllamaModel } from '@/lib/ollama-models';

export default function ChatThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = use(params);
  const {
    chatState,
    sendMessage,
    sendQueuedNow,
    editQueuedMessage,
    queuedMessage,
    composerOptions,
    setComposerOptions,
    isRunning,
    stopGeneration,
    retryLastResponse,
    editLastUserMessage,
    ledgerEpoch,
    threadKind,
  } = useAgentRun(threadId);
  const messages = useMessages(threadId, ledgerEpoch);
  const sentPendingRef = useRef(false);

  useEffect(() => {
    if (sentPendingRef.current) return;
    const pending = takePendingMessage();
    if (!pending) return;
    sentPendingRef.current = true;
    const model = resolveOllamaModel(pending.model ?? '');
    setComposerOptions({
      streaming: pending.streaming,
      webSearch: pending.webSearch ?? true,
      model,
      thinking: pending.thinking,
    });
    void sendMessage(
      pending.content,
      {
        streaming: pending.streaming,
        webSearch: pending.webSearch ?? true,
        model,
        thinking: pending.thinking,
      },
      pending.attachments,
    );
  }, [sendMessage, setComposerOptions]);

  return (
    <ChatShell
      header={<ChatHeader threadId={threadId} />}
      footer={
        <ChatInput
          key={threadId}
          draftScope={threadId}
          threadId={threadId}
          onSend={sendMessage}
          isRunning={isRunning}
          queuedMessage={queuedMessage}
          onSendQueuedNow={() => void sendQueuedNow()}
          onEditQueued={editQueuedMessage}
          composerOptions={composerOptions}
          hideWebSearch={threadKind === 'coding'}
          onComposerOptionsChange={setComposerOptions}
          onStop={() => void stopGeneration()}
          occupiedTokens={chatState.activeRun?.occupiedTokens}
          occupiedCoversStream={chatState.activeRun?.occupiedCoversStream}
          estimatedPromptTokens={chatState.activeRun?.estimatedPromptTokens}
          contextReport={chatState.activeRun?.contextReport}
          streamingContent={chatState.activeRun?.streamingMessage?.content}
          runModel={chatState.activeRun?.model}
        />
      }
    >
      <MessageList
        messages={messages}
        chatState={chatState}
        isRunning={isRunning}
        threadKind={threadKind}
        onRetryLastResponse={() => retryLastResponse()}
        onEditLastUserMessage={(id, content) =>
          editLastUserMessage(id, content)
        }
      />
    </ChatShell>
  );
}

'use client';

import { use, useEffect, useRef } from 'react';
import { ChatHeader } from '../../../components/chat-header';
import { MessageList } from '../../../components/message-list';
import { ChatInput } from '../../../components/chat-input';
import { ThreadPlanCard } from '../../../components/thread-plan-card';
import { ChoiceCard } from '../../../components/choice-card';
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
    resolvePendingChoice,
    retryLastResponse,
    editLastUserMessage,
    ledgerEpoch,
    threadKind,
    isSubagentThread,
  } = useAgentRun(threadId);
  const messages = useMessages(threadId, ledgerEpoch);
  const sentPendingRef = useRef(false);

  useEffect(() => {
    if (sentPendingRef.current) return;
    const pending = takePendingMessage();
    if (!pending) return;
    sentPendingRef.current = true;
    const local = pending.local === true;
    const model = resolveOllamaModel(pending.model ?? '', local);
    setComposerOptions({
      webSearch: pending.webSearch ?? true,
      local,
      model,
      thinking: pending.thinking,
      posture: pending.posture === 'ask' ? 'ask' : 'agent',
      contextWindowMode: pending.contextWindowMode ?? 'default',
    });
    void sendMessage(
      pending.content,
      {
        webSearch: pending.webSearch ?? true,
        local,
        model,
        thinking: pending.thinking,
        posture: pending.posture === 'ask' ? 'ask' : 'agent',
        ...(pending.skills ? { skills: pending.skills } : {}),
        contextWindowMode: pending.contextWindowMode ?? 'default',
      },
      pending.attachments,
    );
  }, [sendMessage, setComposerOptions]);

  return (
    <ChatShell
      header={<ChatHeader threadId={threadId} />}
      footer={
        <div className="relative flex min-w-0 flex-col">
          <div className="mx-auto w-full max-w-4xl px-4 sm:px-6">
            <ChoiceCard
              choice={
                chatState.pendingChoices[
                  chatState.pendingChoices.length - 1
                ] ?? null
              }
              onResolve={resolvePendingChoice}
            />
          </div>
          {/* Live plan overlay: absolute so the composer height never changes. */}
          {isRunning && chatState.plan ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-full z-10 px-4 pb-2 sm:px-6">
              <div className="pointer-events-auto mx-auto w-full max-w-4xl">
                <ThreadPlanCard plan={chatState.plan} />
              </div>
            </div>
          ) : null}
          {isSubagentThread ? (
            <div className="px-4 py-3 text-center text-xs text-muted-foreground">
              Sub-agent thread — read-only
            </div>
          ) : (
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
            showPostureChips={threadKind === 'workspace'}
            runPosture={chatState.activeRun?.posture}
            onComposerOptionsChange={setComposerOptions}
            onStop={() => void stopGeneration()}
            occupiedTokens={chatState.activeRun?.occupiedTokens}
            runPromptTokens={chatState.activeRun?.runPromptTokens}
            runPromptCap={chatState.activeRun?.runPromptCap}
            runUsageEstimated={chatState.activeRun?.runUsageEstimated}
            occupiedCoversStream={chatState.activeRun?.occupiedCoversStream}
            estimatedPromptTokens={chatState.activeRun?.estimatedPromptTokens}
            contextReport={chatState.activeRun?.contextReport}
            streamingContent={chatState.activeRun?.streamingMessage?.content}
            runModel={chatState.activeRun?.model}
          />
          )}
        </div>
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

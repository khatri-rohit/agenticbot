'use client';

import { useCallback, use, useEffect, useRef } from 'react';
import { normalizeRunPosture } from '@agent/agent-models';
import { ChatHeader } from '@/features/conversation/chat-header';
import { MessageList } from '@/features/conversation/message-list';
import { ChatInput } from '@/features/composer/chat-input';
import { ThreadPlanCard } from '@/features/conversation/thread-plan-card';
import { ChoiceCard } from '@/features/conversation/choice-card';
import { ChatShell } from '@/components/shell/chat-shell';
import { useAgentRun } from '@/features/conversation/use-agent-run';
import { takePendingMessage } from '@/api/agent-client';
import { resolveOllamaModel } from '@/features/composer/ollama-models';

export default function ChatThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  const { threadId } = use(params);
  const {
    messages,
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
    threadKind,
    isSubagentThread,
  } = useAgentRun(threadId);
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
      posture: normalizeRunPosture(pending.posture),
      contextWindowMode: pending.contextWindowMode ?? 'default',
    });
    void sendMessage(
      pending.content,
      {
        webSearch: pending.webSearch ?? true,
        local,
        model,
        thinking: pending.thinking,
        posture: normalizeRunPosture(pending.posture),
        ...(pending.skills ? { skills: pending.skills } : {}),
        contextWindowMode: pending.contextWindowMode ?? 'default',
      },
      pending.attachments,
    );
  }, [sendMessage, setComposerOptions]);

  const onContinue = useCallback(
    () => sendMessage('Continue from where the last run stopped.'),
    [sendMessage],
  );

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
            onComposerOptionsChange={setComposerOptions}
            onStop={() => void stopGeneration()}
            activeRun={chatState.activeRun}
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
        onRetryLastResponse={retryLastResponse}
        onEditLastUserMessage={editLastUserMessage}
        {...(isSubagentThread
          ? {}
          : { onContinue })}
      />
    </ChatShell>
  );
}

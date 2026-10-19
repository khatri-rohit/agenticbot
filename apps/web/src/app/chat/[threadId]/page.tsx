'use client';

import { use, useEffect, useRef } from 'react';
import { ChatHeader } from '../../../components/chat-header';
import { MessageList } from '../../../components/message-list';
import { ChatInput } from '../../../components/chat-input';
import { ThreadPlanCard } from '../../../components/thread-plan-card';
/*
 * IMPORTANT: Allow/Deny exec-approval card. Temporarily unused so file and
 * command tools run without a pause. Do not delete this import — it must
 * stay in the tree, commented, until the Allow/Deny system is restored.
 *
 * import { ApprovalCard } from '../../../components/approval-card';
 */
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
    // resolvePendingApproval,
    resolvePendingChoice,
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
    const local = pending.local === true;
    const model = resolveOllamaModel(pending.model ?? '', local);
    setComposerOptions({
      webSearch: pending.webSearch ?? true,
      local,
      model,
      thinking: pending.thinking,
      posture: pending.posture === 'ask' ? 'ask' : 'agent',
    });
    void sendMessage(
      pending.content,
      {
        webSearch: pending.webSearch ?? true,
        local,
        model,
        thinking: pending.thinking,
        posture: pending.posture === 'ask' ? 'ask' : 'agent',
      },
      pending.attachments,
    );
  }, [sendMessage, setComposerOptions]);

  return (
    <ChatShell
      header={<ChatHeader threadId={threadId} />}
      footer={
        <div className="flex min-w-0 flex-col">
          <div className="mx-auto w-full max-w-3xl px-4 sm:px-6">
            <ThreadPlanCard plan={chatState.plan} />
            <ChoiceCard
              choice={
                chatState.pendingChoices[
                  chatState.pendingChoices.length - 1
                ] ?? null
              }
              onResolve={resolvePendingChoice}
            />
            {/*
              IMPORTANT: Allow/Deny exec-approval card. Temporarily commented
              so file and command tools run without a pause, as they did before
              this card. Do not delete this block — it must stay in the tree,
              commented, until the Allow/Deny system is restored.

              <ApprovalCard
                approval={
                  chatState.pendingApprovals[
                    chatState.pendingApprovals.length - 1
                  ] ?? null
                }
                onResolve={resolvePendingApproval}
              />
            */}
          </div>
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
            occupiedCoversStream={chatState.activeRun?.occupiedCoversStream}
            estimatedPromptTokens={chatState.activeRun?.estimatedPromptTokens}
            contextReport={chatState.activeRun?.contextReport}
            streamingContent={chatState.activeRun?.streamingMessage?.content}
            runModel={chatState.activeRun?.model}
          />
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

'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { ArrowDown } from 'lucide-react';
import { useStickToBottom } from '../hooks/use-stick-to-bottom';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { Message } from '@org/agent-models';
import type {
  ChatState,
  CompactionNotice,
  ToolActivity,
} from '../features/agent/store/chat-store';
import { groupMessageTurns } from '../lib/group-message-turns';
import { buildTurnTimeline } from '../lib/turn-timeline';
import { formatMessageTime } from '../lib/format-relative-time';
import { AgentMarkdown } from './agent-markdown';
import {
  ConversationRail,
  shouldShowConversationRail,
} from './conversation-rail';
import { MessageActions } from './message-actions';
import { CompactionCard } from './compaction-card';
import { ToolStepList } from './tool-call-panel';
import { UserMessage } from './user-message';

export function MessageList({
  messages,
  chatState,
  isRunning,
  threadKind = 'home',
  onRetryLastResponse,
  onEditLastUserMessage,
}: {
  messages: Message[] | undefined;
  chatState: ChatState;
  isRunning: boolean;
  threadKind?: 'home' | 'workspace';
  onRetryLastResponse: () => void | Promise<void>;
  onEditLastUserMessage: (
    messageId: string,
    content: string,
  ) => void | Promise<void>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const anchorRefs = useRef(new Map<string, HTMLDivElement>());

  const streaming = chatState.activeRun?.streamingMessage;
  const toolActivity = chatState.activeRun?.toolActivity ?? [];
  const assistantSnippets = chatState.activeRun?.assistantSnippets ?? [];
  const activeRunId = chatState.activeRun?.runId;
  const compactionNotice = chatState.compactionNotice;

  const turns = useMemo(() => groupMessageTurns(messages ?? []), [messages]);

  const userAnchors = useMemo(() => {
    return turns.map((turn) => {
      const trimmed = turn.userMessage.content.trim();
      const attachmentCount = turn.userMessage.attachments?.length ?? 0;
      let label = trimmed;
      if (!label) {
        label =
          attachmentCount === 1
            ? '1 image'
            : attachmentCount > 1
              ? `${attachmentCount} images`
              : 'Message';
      }
      return { id: turn.userMessage.id, label };
    });
  }, [turns]);

  const showRail = shouldShowConversationRail(userAnchors.length);

  const registerAnchor = useCallback(
    (id: string, el: HTMLDivElement | null) => {
      if (el) anchorRefs.current.set(id, el);
      else anchorRefs.current.delete(id);
    },
    [],
  );

  const getAnchorElement = useCallback((id: string) => {
    return anchorRefs.current.get(id) ?? null;
  }, []);

  const {
    showJumpToBottom,
    followContent,
    jumpToBottomAndFollow,
    enableStickToBottom,
  } = useStickToBottom(scrollRef);

  const prevMessageCount = useRef(0);
  useEffect(() => {
    const count = messages?.length ?? 0;
    if (count > prevMessageCount.current) {
      enableStickToBottom();
    }
    prevMessageCount.current = count;
  }, [messages?.length, enableStickToBottom]);

  useEffect(() => {
    followContent('auto');
  }, [
    messages,
    streaming?.content,
    toolActivity.length,
    assistantSnippets.length,
    compactionNotice?.status,
    compactionNotice?.throughSeq,
    followContent,
  ]);

  const hasMessages = (messages?.length ?? 0) > 0;
  const lastTurnIndex = turns.length - 1;

  const latestAssistantMessageId = useMemo(() => {
    if (!messages?.length) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') return messages[i].id;
    }
    return null;
  }, [messages]);

  const latestUserMessageId = useMemo(() => {
    if (!messages?.length) return null;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return messages[i].id;
    }
    return null;
  }, [messages]);

  return (
    <div className="relative flex min-h-0 flex-1">
      {showJumpToBottom && (
        <div className="pointer-events-none absolute inset-x-0 bottom-20 z-30 flex justify-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="secondary"
                className="pointer-events-auto size-8 rounded-full border border-border/50 bg-card/95 shadow-sm backdrop-blur-sm"
                onClick={jumpToBottomAndFollow}
                aria-label="Scroll to latest messages"
              >
                <ArrowDown className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Jump to latest</TooltipContent>
          </Tooltip>
        </div>
      )}
      {showRail && (
        <ConversationRail
          anchors={userAnchors}
          scrollContainerRef={scrollRef}
          getAnchorElement={getAnchorElement}
        />
      )}
      <div
        ref={scrollRef}
        className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto scrollbar-gutter-stable [overflow-anchor:none]"
      >
        <div className="mx-auto w-full min-w-0 max-w-3xl px-4 py-5 sm:px-6">
          {!hasMessages && !isRunning && !streaming?.content && (
            <p className="type-ui text-center text-muted-foreground/70">
              Conversation will appear here.
            </p>
          )}

          <div className="flex flex-col gap-8">
            {turns.map((turn, index) => {
              const isLastTurn = index === lastTurnIndex;
              const liveActivity = isLastTurn ? toolActivity : [];
              const liveStreaming = isLastTurn ? streaming : null;
              const liveSnippets = isLastTurn ? assistantSnippets : [];
              const turnCompaction = turnOwnsCompaction(
                turn.replies,
                compactionNotice,
                isLastTurn,
              )
                ? compactionNotice
                : null;
              const steps = buildTurnTimeline({
                replies: turn.replies,
                liveActivity,
                snippets: liveSnippets,
                activeRunId,
                streaming: liveStreaming,
                compaction: turnCompaction,
              });
              const showSteps =
                turn.replies.length > 0 ||
                liveActivity.length > 0 ||
                liveSnippets.length > 0 ||
                Boolean(liveStreaming?.content) ||
                Boolean(turnCompaction);

              return (
                <section
                  key={turn.userMessage.id}
                  className="flex flex-col gap-3.5"
                  aria-label="Conversation turn"
                >
                  <UserMessage
                    message={turn.userMessage}
                    registerAnchor={registerAnchor}
                    canEdit={
                      isLastTurn && turn.userMessage.id === latestUserMessageId
                    }
                    hasResponseBelow={
                      isLastTurn &&
                      (turn.replies.length > 0 ||
                        isRunning ||
                        Boolean(streaming?.content) ||
                        Boolean(turnCompaction))
                    }
                    onEditSubmit={onEditLastUserMessage}
                  />

                  {showSteps ? (
                    <div className="flex min-w-0 flex-col gap-3">
                      {steps.map((step) => {
                        if (step.type === 'assistant') {
                          return (
                            <AssistantMessage
                              key={step.message.id}
                              message={step.message}
                              showRetry={
                                !isRunning &&
                                step.message.id === latestAssistantMessageId
                              }
                              onRetry={onRetryLastResponse}
                              retryDisabled={isRunning}
                            />
                          );
                        }
                        if (step.type === 'snippet') {
                          return (
                            <div
                              key={`snippet-${step.messageId}`}
                              className="min-w-0 max-w-full"
                            >
                              <article className="chat-prose type-body min-w-0 max-w-full">
                                <AgentMarkdown content={step.content} />
                              </article>
                              <MessageMetaRow>
                                <MessageActions
                                  content={step.content}
                                  align="start"
                                />
                              </MessageMetaRow>
                            </div>
                          );
                        }
                        if (step.type === 'tools') {
                          return (
                            <ToolStepList
                              key={step.key}
                              rows={step.rows}
                              variant={threadKind}
                            />
                          );
                        }
                        if (step.type === 'compaction') {
                          return (
                            <CompactionCard
                              key={`compaction-${step.notice.runId ?? step.notice.throughSeq}`}
                              notice={step.notice}
                            />
                          );
                        }
                        return (
                          <div
                            key="stream"
                            className="min-w-0 max-w-full"
                          >
                            <article className="chat-prose type-body min-w-0 max-w-full">
                              <AgentMarkdown content={step.content} streaming />
                            </article>
                            <MessageMetaRow>
                              <MessageActions
                                content={step.content}
                                align="start"
                              />
                            </MessageMetaRow>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}

                  {isLastTurn &&
                  (isRunning || compactionNotice?.status === 'running') ? (
                    <TurnStatusLine
                      toolActivity={toolActivity}
                      hasStreamingText={Boolean(streaming?.content)}
                      compacting={compactionNotice?.status === 'running'}
                      waitingForApproval={
                        /*
                         * IMPORTANT: Allow/Deny exec-approval status.
                         * Temporarily forced off so file and command tools
                         * run without a pause. Do not delete the original
                         * check — it must stay in the tree, commented, until
                         * the Allow/Deny system is restored.
                         *
                         * chatState.pendingApprovals.length > 0
                         */
                        false
                      }
                      waitingForChoice={
                        chatState.pendingChoices.length > 0
                      }
                    />
                  ) : null}
                </section>
              );
            })}
          </div>

          {chatState.limitNotice ? (
            <p className="type-caption px-1 text-muted-foreground" role="status">
              Run stopped early: {chatState.limitNotice.reason}
            </p>
          ) : null}

          <div ref={endRef} className="h-6" />
        </div>
      </div>
    </div>
  );
}

/** Attach compaction to the turn that produced it (by runId), else last turn. */
function turnOwnsCompaction(
  replies: Message[],
  notice: CompactionNotice | null,
  isLastTurn: boolean,
): boolean {
  if (!notice) return false;
  if (notice.status === 'running') return isLastTurn;
  if (notice.runId) {
    return replies.some((message) => message.runId === notice.runId);
  }
  return isLastTurn;
}

/** Quiet “still working” cue for model think gaps when no stream is visible. */
function TurnStatusLine({
  toolActivity,
  hasStreamingText,
  compacting,
  waitingForApproval,
  waitingForChoice,
}: {
  toolActivity: ToolActivity[];
  hasStreamingText: boolean;
  compacting?: boolean;
  waitingForApproval?: boolean;
  waitingForChoice?: boolean;
}) {
  const running = toolActivity.find((t) => t.status === 'running');
  let label: string | null = null;

  if (compacting) {
    label = 'Compacting context…';
  } else if (waitingForChoice) {
    label = 'Waiting for a choice…';
  } else if (waitingForApproval) {
    label = 'Waiting for approval…';
  } else if (running) {
    label = `${running.toolName}…`;
  } else if (toolActivity.length > 0 && !hasStreamingText) {
    label = 'Working…';
  } else if (!hasStreamingText) {
    label = 'Working…';
  }

  if (!label) return null;

  return (
    <p
      className="type-caption pl-0.5 text-left text-muted-foreground/65 tabular-nums"
      aria-live="polite"
    >
      {label}
    </p>
  );
}

function MessageTimestamp({ iso }: { iso: string }) {
  const text = formatMessageTime(iso);
  if (!text) return null;
  return (
    <time
      dateTime={iso}
      className="type-caption text-muted-foreground/55 tabular-nums"
    >
      {text}
    </time>
  );
}

/**
 * One meta row per message: timestamp left, actions right. Always visible —
 * hover-gating hides the primary affordances on touch and during streaming.
 */
function MessageMetaRow({
  iso,
  children,
}: {
  iso?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
      <MessageTimestamp iso={iso ?? ''} />
      <div className="flex min-w-0 items-center">{children}</div>
    </div>
  );
}

function AssistantMessage({
  message,
  showRetry,
  onRetry,
  retryDisabled,
}: {
  message: Message;
  showRetry?: boolean;
  onRetry: () => void | Promise<void>;
  retryDisabled?: boolean;
}) {
  if (!message.content.trim()) return null;

  return (
    <div className="min-w-0 max-w-full">
      <article className="chat-prose type-body min-w-0 max-w-full">
        <AgentMarkdown content={message.content} />
      </article>
      <MessageMetaRow iso={message.createdAt}>
        <MessageActions
          content={message.content}
          align="start"
          showRetry={showRetry}
          onRetry={onRetry}
          disabled={retryDisabled}
        />
      </MessageMetaRow>
    </div>
  );
}

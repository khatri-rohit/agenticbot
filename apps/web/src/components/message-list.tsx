'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown } from 'lucide-react';
import { useStickToBottom } from '../hooks/use-stick-to-bottom';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { Message } from '@agent/agent-models';
import type {
  ChatState,
  CompactionNotice,
  ToolActivity,
} from '../features/agent/store/chat-store';
import { groupMessageTurns } from '../lib/group-message-turns';
import { buildTurnTimeline } from '../lib/turn-timeline';
import { formatDuration, formatMessageTime } from '../lib/format-relative-time';
import { AgentMarkdown } from './agent-markdown';
import {
  ConversationRail,
  shouldShowConversationRail,
} from './conversation-rail';
import { MessageActions } from './message-actions';
import { CompactionCard } from './compaction-card';
import { ToolStepList } from './tool-call-panel';
import { PlanChip } from './thread-plan-card';
import { UserMessage } from './user-message';
import { cn } from 'cn';

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
        className={cn(
          'min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto scrollbar-gutter-stable [overflow-anchor:none]',
          // Keep the newest lines reachable above the floating plan card.
          isRunning && chatState.plan ? 'pb-40' : 'pb-5',
        )}
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

                  {/* Settled plan pins under its anchor user message; while
                      a run is live the plan floats above the composer instead. */}
                  {isLastTurn && !isRunning ? (
                    <PlanChip plan={chatState.plan} />
                  ) : null}

                  {showSteps ? (
                    <div className="flex min-w-0 flex-col gap-3">
                      {steps.map((step) => {
                        if (step.type === 'assistant') {
                          const isLatestAssistant =
                            step.message.id === latestAssistantMessageId;
                          return (
                            <AssistantMessage
                              key={step.message.id}
                              message={step.message}
                              showMeta={isLatestAssistant}
                              showRetry={!isRunning && isLatestAssistant}
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
                          <div key="stream" className="min-w-0 max-w-full">
                            <article className="chat-prose type-body min-w-0 max-w-full">
                              <AgentMarkdown content={step.content} streaming />
                            </article>
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
                      waitingForChoice={chatState.pendingChoices.length > 0}
                    />
                  ) : null}
                </section>
              );
            })}
          </div>

          {chatState.limitNotice ? (
            <p
              className="type-caption px-1 text-muted-foreground"
              role="status"
            >
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
  waitingForChoice,
}: {
  toolActivity: ToolActivity[];
  hasStreamingText: boolean;
  compacting?: boolean;
  waitingForChoice?: boolean;
}) {
  const running = toolActivity.find((t) => t.status === 'running');
  let label: string | null = null;

  if (compacting) {
    label = 'Compacting context…';
  } else if (waitingForChoice) {
    label = 'Waiting for a choice…';
  } else if (running) {
    label = `${running.toolName}…`;
  } else if (toolActivity.length > 0 && !hasStreamingText) {
    label = 'Working…';
  } else if (!hasStreamingText) {
    label = 'Working…';
  }

  // Each phase (tool call, think gap) gets its own clock keyed on the label.
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    setElapsed(0);
    if (!label) return;
    const id = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(id);
  }, [label]);

  if (!label) return null;

  return (
    <p
      className="type-caption flex items-center gap-1.5 pl-0.5 text-left text-muted-foreground/70 tabular-nums"
      aria-live="polite"
    >
      <span
        className="size-1.5 shrink-0 rounded-full bg-primary/80 animate-pulse"
        aria-hidden
      />
      {label}
      <span className="text-muted-foreground/50">{elapsed}s</span>
    </p>
  );
}

function MessageTimestamp({
  iso,
  durationMs,
}: {
  iso: string;
  durationMs?: number;
}) {
  const text = formatMessageTime(iso);
  if (!text) return null;
  return (
    <time
      dateTime={iso}
      className="type-caption text-muted-foreground/55 tabular-nums"
    >
      {text}
      {durationMs != null && ` · ${formatDuration(durationMs)}`}
    </time>
  );
}

/**
 * One meta row per message: timestamp left, actions right. Always visible —
 * hover-gating hides the primary affordances on touch and during streaming.
 */
function MessageMetaRow({
  iso,
  durationMs,
  children,
}: {
  iso?: string;
  durationMs?: number;
  children: React.ReactNode;
}) {
  return (
    <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
      <MessageTimestamp iso={iso ?? ''} durationMs={durationMs} />
      <div className="flex min-w-0 items-center">{children}</div>
    </div>
  );
}

function AssistantMessage({
  message,
  showMeta = true,
  showRetry,
  onRetry,
  retryDisabled,
}: {
  message: Message;
  /** Meta footer (time · duration · Copy) only on the turn's final response. */
  showMeta?: boolean;
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
      {showMeta ? (
        <MessageMetaRow iso={message.createdAt} durationMs={message.durationMs}>
          <MessageActions
            content={message.content}
            align="start"
            showRetry={showRetry}
            onRetry={onRetry}
            disabled={retryDisabled}
          />
        </MessageMetaRow>
      ) : null}
    </div>
  );
}

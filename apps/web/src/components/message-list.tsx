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
  ToolActivity,
} from '../features/agent/store/chat-store';
import { groupMessageTurns } from '../lib/group-message-turns';
import { AgentMarkdown } from './agent-markdown';
import {
  ConversationRail,
  shouldShowConversationRail,
} from './conversation-rail';
import { MessageActions } from './message-actions';
import { UserMessage } from './user-message';

export function MessageList({
  messages,
  chatState,
  isRunning,
  onRetryLastResponse,
  onEditLastUserMessage,
}: {
  messages: Message[] | undefined;
  chatState: ChatState;
  isRunning: boolean;
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

  const turns = useMemo(() => groupMessageTurns(messages ?? []), [messages]);

  const userAnchors = useMemo(() => {
    return turns.map((t) => ({
      id: t.userMessage.id,
      label: t.userMessage.content,
    }));
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
    followContent(streaming?.content ? 'auto' : 'smooth');
  }, [messages, streaming?.content, toolActivity.length, followContent]);

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
        <div className="pointer-events-none absolute inset-x-0 bottom-6 z-30 flex justify-center">
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
        className="min-h-0 flex-1 overflow-y-auto scroll-smooth scrollbar-gutter-stable"
      >
        <div className="mx-auto w-full max-w-3xl px-5 py-7 sm:pl-14 sm:pr-6">
          {!hasMessages && !isRunning && !streaming?.content && (
            <p className="type-ui text-center text-muted-foreground/80">
              Your research thread will appear here.
            </p>
          )}

          <div className="flex flex-col gap-12">
            {turns.map((turn, index) => {
              const isLastTurn = index === lastTurnIndex;
              return (
                <section
                  key={turn.userMessage.id}
                  className="flex flex-col gap-3"
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
                        Boolean(streaming?.content))
                    }
                    onEditSubmit={onEditLastUserMessage}
                  />

                  {isLastTurn && isRunning && (
                    <TurnStatusLine
                      toolActivity={toolActivity}
                      hasStreamingText={Boolean(streaming?.content)}
                    />
                  )}

                  {turn.replies.length > 0 && (
                    <div className="flex flex-col gap-4 pt-1">
                      {turn.replies.map((msg) => (
                        <AssistantMessage
                          key={msg.id}
                          message={msg}
                          showRetry={
                            !isRunning &&
                            msg.role === 'assistant' &&
                            msg.id === latestAssistantMessageId
                          }
                          onRetry={onRetryLastResponse}
                          retryDisabled={isRunning}
                        />
                      ))}
                    </div>
                  )}

                  {isLastTurn && toolActivity.length > 0 && (
                    <div className="space-y-1.5 border-l border-border/50 pl-3">
                      {toolActivity.map((tool) => (
                        <ToolStatus key={tool.toolCallId} tool={tool} />
                      ))}
                    </div>
                  )}

                  {isLastTurn && streaming?.content && (
                    <div className="group/msg">
                      <article className="chat-prose type-body">
                        <AgentMarkdown content={streaming.content} streaming />
                      </article>
                      <MessageActions
                        content={streaming.content}
                        align="start"
                        className="opacity-100 sm:opacity-0 sm:transition-opacity sm:group-hover/msg:opacity-100 sm:group-focus-within/msg:opacity-100"
                      />
                    </div>
                  )}
                </section>
              );
            })}
          </div>

          <div ref={endRef} className="h-10" />
        </div>
      </div>
    </div>
  );
}

function TurnStatusLine({
  toolActivity,
  hasStreamingText,
}: {
  toolActivity: ToolActivity[];
  hasStreamingText: boolean;
}) {
  const running = toolActivity.find((t) => t.status === 'running');
  let label: string | null = null;

  if (running) {
    label = `${running.toolName}…`;
  } else if (toolActivity.length > 0 && !hasStreamingText) {
    label = 'Running tools…';
  } else if (!hasStreamingText) {
    label = 'Working…';
  }

  if (!label) return null;

  return (
    <p
      className="type-caption text-right text-muted-foreground/70 tabular-nums"
      aria-live="polite"
    >
      {label}
    </p>
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
  if (message.role === 'tool') {
    return (
      <div>
        <p className="type-caption text-muted-foreground/80">
          Tool result
          {message.toolCallId ? ` (${message.toolCallId.slice(0, 8)}…)` : ''}
        </p>
        <MessageActions content={message.content} align="start" />
      </div>
    );
  }

  return (
    <div className="group/msg">
      <article className="chat-prose type-body">
        <AgentMarkdown content={message.content} />
      </article>
      <MessageActions
        content={message.content}
        align="start"
        showRetry={showRetry}
        onRetry={onRetry}
        disabled={retryDisabled}
        className="opacity-0 transition-opacity group-hover/msg:opacity-100 group-focus-within/msg:opacity-100"
      />
    </div>
  );
}

function ToolStatus({
  tool,
}: {
  tool: { toolName: string; status: string; durationMs?: number };
}) {
  const label =
    tool.status === 'running'
      ? `${tool.toolName} running`
      : tool.status === 'failed'
        ? `${tool.toolName} failed`
        : `${tool.toolName} done${tool.durationMs ? ` (${tool.durationMs}ms)` : ''}`;

  return <p className="type-caption text-muted-foreground/85">{label}</p>;
}

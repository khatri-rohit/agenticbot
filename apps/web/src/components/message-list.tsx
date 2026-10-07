'use client';

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { Message } from '@org/agent-models';
import type {
  ChatState,
  ToolActivity,
} from '../features/agent/store/chat-store';
import { groupMessageTurns } from '../lib/group-message-turns';
import { cn } from '../lib/utils';
import { AgentMarkdown } from './agent-markdown';
import {
  ConversationRail,
  shouldShowConversationRail,
} from './conversation-rail';

export function MessageList({
  messages,
  chatState,
}: {
  messages: Message[] | undefined;
  chatState: ChatState;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const anchorRefs = useRef(new Map<string, HTMLDivElement>());

  const streaming = chatState.activeRun?.streamingMessage;
  const toolActivity = chatState.activeRun?.toolActivity ?? [];
  const isRunning = chatState.activeRun?.status === 'running';

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

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming?.content, toolActivity.length]);

  const hasMessages = (messages?.length ?? 0) > 0;
  const lastTurnIndex = turns.length - 1;

  return (
    <div className="relative flex min-h-0 flex-1">
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
        <div className="mx-auto w-full max-w-3xl px-6 py-8 sm:pl-14">
          {!hasMessages && !isRunning && !streaming?.content && (
            <p className="text-center text-sm text-muted-foreground/80">
              Your research thread will appear here.
            </p>
          )}

          <div className="flex flex-col gap-14">
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
                  />

                  {isLastTurn && isRunning && (
                    <TurnStatusLine
                      toolActivity={toolActivity}
                      hasStreamingText={Boolean(streaming?.content)}
                    />
                  )}

                  {turn.replies.length > 0 && (
                    <div className="flex flex-col gap-5 pt-0.5">
                      {turn.replies.map((msg) => (
                        <AssistantMessage key={msg.id} message={msg} />
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
                    <article className="text-[15px] leading-relaxed text-foreground/95">
                      <AgentMarkdown content={streaming.content} streaming />
                    </article>
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

function UserMessage({
  message,
  registerAnchor,
}: {
  message: Message;
  registerAnchor: (id: string, el: HTMLDivElement | null) => void;
}) {
  return (
    <div
      ref={(el) => registerAnchor(message.id, el)}
      id={`conversation-anchor-${message.id}`}
      className="scroll-mt-8"
    >
      <div className="flex justify-end">
        <div
          className={cn(
            'max-w-[min(100%,36rem)] rounded-xl bg-muted/70 px-4 py-2.5 text-[15px] leading-relaxed text-foreground',
          )}
        >
          <p className="whitespace-pre-wrap">{message.content}</p>
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
      className="text-right text-xs text-muted-foreground/75 tabular-nums"
      aria-live="polite"
    >
      {label}
    </p>
  );
}

function AssistantMessage({ message }: { message: Message }) {
  if (message.role === 'tool') {
    return (
      <p className="text-xs text-muted-foreground/80">
        Tool result
        {message.toolCallId ? ` (${message.toolCallId.slice(0, 8)}…)` : ''}
      </p>
    );
  }

  return (
    <article className="text-[15px] leading-relaxed text-foreground/95">
      <AgentMarkdown content={message.content} />
    </article>
  );
}

function ToolStatus({
  tool,
}: {
  tool: { toolName: string; status: string; durationMs?: number };
}) {
  const label =
    tool.status === 'running'
      ? `${tool.toolName} — running`
      : tool.status === 'failed'
        ? `${tool.toolName} — failed`
        : `${tool.toolName} — done${tool.durationMs ? ` (${tool.durationMs}ms)` : ''}`;

  return <p className="text-xs text-muted-foreground/85">{label}</p>;
}

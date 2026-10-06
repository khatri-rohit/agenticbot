'use client';

import { useEffect, useRef } from 'react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import type { Message } from '@org/agent-models';
import type { ChatState } from '../features/agent/store/chat-store';
import { cn } from '../lib/utils';

const streamdownPlugins = { code };

export function MessageList({
  messages,
  chatState,
}: {
  messages: Message[] | undefined;
  chatState: ChatState;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  const streaming = chatState.activeRun?.streamingMessage;
  const toolActivity = chatState.activeRun?.toolActivity ?? [];
  const isRunning = chatState.activeRun?.status === 'running';

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming?.content, toolActivity.length]);

  const hasMessages = (messages?.length ?? 0) > 0;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        {!hasMessages && !isRunning && !streaming?.content && (
          <p className="text-center text-sm text-muted-foreground">
            Messages appear here.
          </p>
        )}

        <div className="space-y-8">
          {messages?.map((msg) => (
            <MessageRow key={msg.id} message={msg} />
          ))}

          {toolActivity.length > 0 && (
            <div className="space-y-2 border-l-2 border-border pl-4">
              {toolActivity.map((tool) => (
                <ToolStatus key={tool.toolCallId} tool={tool} />
              ))}
            </div>
          )}

          {streaming && streaming.content && (
            <article className="text-[15px] leading-relaxed text-foreground">
              <Streamdown animated isAnimating plugins={streamdownPlugins}>
                {streaming.content}
              </Streamdown>
            </article>
          )}

          {isRunning && !streaming?.content && (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Working…
            </p>
          )}
        </div>

        <div ref={endRef} className="h-4" />
      </div>
    </div>
  );
}

function MessageRow({ message }: { message: Message }) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div
          className={cn(
            'max-w-[min(100%,32rem)] rounded-lg bg-muted px-4 py-3 text-[15px] leading-relaxed text-foreground',
          )}
        >
          <p className="whitespace-pre-wrap">{message.content}</p>
        </div>
      </div>
    );
  }

  return (
    <article className="text-[15px] leading-relaxed text-foreground">
      <Streamdown plugins={streamdownPlugins}>{message.content}</Streamdown>
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

  return <p className="text-sm text-muted-foreground">{label}</p>;
}

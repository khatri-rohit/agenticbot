'use client';

import { useEffect, useRef } from 'react';
import type { Message } from '@org/agent-models';
import type { ChatState } from '../features/agent/store/chat-store';

export function MessageList({
  messages,
  chatState,
}: {
  messages: Message[] | undefined;
  chatState: ChatState;
}) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, chatState.activeRun?.streamingMessage]);

  const streaming = chatState.activeRun?.streamingMessage;
  const toolActivity = chatState.activeRun?.toolActivity ?? [];
  const isRunning = chatState.activeRun?.status === 'running';

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-6">
      {messages?.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}

      {streaming && (
        <div className="mb-4">
          <div className="mb-1 text-xs font-semibold uppercase text-zinc-500">
            Assistant
          </div>
          <div className="text-[15px] leading-relaxed whitespace-pre-wrap">
            {streaming.content}
            <span className="ml-0.5 inline-block animate-pulse text-zinc-500">
              ▊
            </span>
          </div>
        </div>
      )}

      {toolActivity.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {toolActivity.map((tool) => (
            <ToolChip key={tool.toolCallId} tool={tool} />
          ))}
        </div>
      )}

      {isRunning && !streaming && (
        <div className="mb-4 text-sm italic text-zinc-500">Thinking…</div>
      )}

      <div ref={endRef} />
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  return (
    <div className={`mb-4 ${isUser ? '' : ''}`}>
      <div className="mb-1 text-xs font-semibold uppercase text-zinc-500">
        {isUser ? 'You' : 'Assistant'}
      </div>
      <div
        className={`rounded-xl px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap ${
          isUser
            ? 'bg-blue-600/10 text-zinc-200'
            : 'bg-zinc-900 text-zinc-200'
        }`}
      >
        {message.content}
      </div>
    </div>
  );
}

function ToolChip({
  tool,
}: {
  tool: { toolName: string; status: string; durationMs?: number };
}) {
  const icon =
    tool.status === 'running'
      ? '🔄'
      : tool.status === 'failed'
        ? '❌'
        : '✓';
  const label = `${icon} ${tool.toolName}`;
  const time = tool.durationMs ? ` (${tool.durationMs}ms)` : '';
  return (
    <span className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs text-zinc-400">
      {label}
      {time}
    </span>
  );
}
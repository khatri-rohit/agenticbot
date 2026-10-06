'use client';

import { useEffect, useRef } from 'react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import type { Message } from '@org/agent-models';
import type { ChatState } from '../features/agent/store/chat-store';

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

  // Auto-scroll when messages or streaming content change
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming?.content]);

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto p-6">
      {messages?.map((msg) => (
        <MessageBubble key={msg.id} message={msg} />
      ))}

      {/* Tool activity chips */}
      {toolActivity.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {toolActivity.map((tool) => (
            <ToolChip key={tool.toolCallId} tool={tool} />
          ))}
        </div>
      )}

      {/* Streaming assistant response */}
      {streaming && streaming.content && (
        <div className="mb-4">
          <div className="mb-1 text-xs font-semibold uppercase text-zinc-500">
            Assistant
          </div>
          <div className="rounded-xl bg-zinc-900 px-4 py-2.5 text-[15px] leading-relaxed text-zinc-200">
            <Streamdown
              animated
              isAnimating
              plugins={streamdownPlugins}
            >
              {streaming.content}
            </Streamdown>
          </div>
        </div>
      )}

      {/* Loading state: run started but no content yet */}
      {isRunning && !streaming?.content && <ThinkingIndicator />}

      <div ref={endRef} />
    </div>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  return (
    <div className="mb-4">
      <div className="mb-1 text-xs font-semibold uppercase text-zinc-500">
        {isUser ? 'You' : 'Assistant'}
      </div>
      {isUser ? (
        <div className="rounded-xl bg-blue-600/10 px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-zinc-200">
          {message.content}
        </div>
      ) : (
        <div className="rounded-xl bg-zinc-900 px-4 py-2.5 text-[15px] leading-relaxed text-zinc-200">
          <Streamdown plugins={streamdownPlugins}>{message.content}</Streamdown>
        </div>
      )}
    </div>
  );
}

/**
 * Animated "Thinking…" indicator shown when the run is active
 * but the first content chunk hasn't arrived yet.
 */
function ThinkingIndicator() {
  return (
    <div className="mb-4">
      <div className="mb-1 text-xs font-semibold uppercase text-zinc-500">
        Assistant
      </div>
      <div className="flex items-center gap-2 rounded-xl bg-zinc-900 px-4 py-3">
        <span className="flex gap-1">
          <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-500 [animation-delay:-0.3s]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-500 [animation-delay:-0.15s]" />
          <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-500" />
        </span>
        <span className="text-sm text-zinc-500">Thinking…</span>
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
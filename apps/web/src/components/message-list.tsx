'use client';

import { useEffect, useRef } from 'react';
import { Streamdown } from 'streamdown';
import { code } from '@streamdown/code';
import { User, Bot, Loader2, Wrench, Check, X } from 'lucide-react';
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

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streaming?.content, toolActivity.length]);

  return (
    <div className="mx-auto w-full max-w-3xl flex-1 overflow-y-auto px-6 py-6">
      {messages?.map((msg) => (
        <MessageRow key={msg.id} message={msg} />
      ))}

      {/* Tool activity */}
      {toolActivity.length > 0 && (
        <div className="mb-3 flex flex-col gap-1.5">
          {toolActivity.map((tool) => (
            <ToolRow key={tool.toolCallId} tool={tool} />
          ))}
        </div>
      )}

      {/* Streaming assistant response */}
      {streaming && streaming.content && (
        <div className="mb-6 flex gap-3">
          <Avatar role="assistant" />
          <div className="min-w-0 flex-1 pt-0.5">
            <Streamdown animated isAnimating plugins={streamdownPlugins}>
              {streaming.content}
            </Streamdown>
          </div>
        </div>
      )}

      {/* Loading state: run active but no content yet */}
      {isRunning && !streaming?.content && <ThinkingIndicator />}

      <div ref={endRef} />
    </div>
  );
}

function MessageRow({ message }: { message: Message }) {
  const isUser = message.role === 'user';

  return (
    <div className="mb-6 flex gap-3">
      <Avatar role={isUser ? 'user' : 'assistant'} />
      <div className="min-w-0 flex-1 pt-0.5">
        {isUser ? (
          <p className="text-[15px] leading-relaxed whitespace-pre-wrap text-zinc-200">
            {message.content}
          </p>
        ) : (
          <div className="streamdown-body text-[15px] leading-relaxed text-zinc-200">
            <Streamdown plugins={streamdownPlugins}>{message.content}</Streamdown>
          </div>
        )}
      </div>
    </div>
  );
}

function Avatar({ role }: { role: 'user' | 'assistant' }) {
  if (role === 'user') {
    return (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zinc-700">
        <User className="h-4 w-4 text-zinc-300" />
      </div>
    );
  }
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600">
      <Bot className="h-4 w-4 text-white" />
    </div>
  );
}

function ThinkingIndicator() {
  return (
    <div className="mb-6 flex gap-3">
      <Avatar role="assistant" />
      <div className="flex items-center gap-2 pt-2">
        <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
        <span className="text-sm text-zinc-500">Thinking…</span>
      </div>
    </div>
  );
}

function ToolRow({
  tool,
}: {
  tool: { toolName: string; status: string; durationMs?: number };
}) {
  const isRunning = tool.status === 'running';
  const isFailed = tool.status === 'failed';

  return (
    <div className="flex items-center gap-2 rounded-lg bg-zinc-900/60 px-3 py-2 text-sm">
      <div className="flex h-5 w-5 items-center justify-center">
        {isRunning ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-400" />
        ) : isFailed ? (
          <X className="h-3.5 w-3.5 text-red-400" />
        ) : (
          <Check className="h-3.5 w-3.5 text-green-400" />
        )}
      </div>
      <Wrench className="h-3 w-3 text-zinc-600" />
      <span className="text-zinc-400">{tool.toolName}</span>
      {tool.durationMs && (
        <span className="text-xs text-zinc-600">{tool.durationMs}ms</span>
      )}
    </div>
  );
}
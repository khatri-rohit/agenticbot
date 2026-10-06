'use client';

import { useState, useCallback } from 'react';

export function ChatInput({
  onSend,
  disabled,
}: {
  onSend: (content: string, options: { streaming: boolean }) => void;
  disabled: boolean;
}) {
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(true);

  const handleSend = useCallback(() => {
    if (!input.trim()) return;
    const content = input.trim();
    setInput('');
    onSend(content, { streaming });
  }, [input, onSend, streaming]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="mx-auto w-full max-w-3xl border-t border-zinc-800 p-4">
      <div className="flex items-end gap-2">
        <button
          onClick={() => setStreaming(!streaming)}
          title="Toggle streaming mode"
          className={`whitespace-nowrap rounded-lg border px-3 py-2 text-xs transition ${
            streaming
              ? 'border-blue-600 bg-blue-600/10 text-blue-400'
              : 'border-zinc-800 bg-zinc-900 text-zinc-500'
          }`}
        >
          {streaming ? '⚡ Streaming' : '⏸ Non-streaming'}
        </button>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message…"
          rows={1}
          disabled={disabled}
          className="min-h-[40px] max-h-[120px] flex-1 resize-none rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-2.5 text-[15px] text-zinc-200 outline-none focus:border-blue-600"
        />
        <button
          onClick={handleSend}
          disabled={!input.trim() || disabled}
          className={`whitespace-nowrap rounded-lg px-5 py-2.5 text-sm font-medium transition ${
            !input.trim() || disabled
              ? 'cursor-not-allowed bg-zinc-800 text-zinc-600'
              : 'bg-blue-600 text-white hover:bg-blue-700'
          }`}
        >
          Send
        </button>
      </div>
    </div>
  );
}
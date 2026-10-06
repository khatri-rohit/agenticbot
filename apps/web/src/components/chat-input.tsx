'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { ArrowUp, Zap, ZapOff } from 'lucide-react';

export function ChatInput({
  onSend,
  disabled,
}: {
  onSend: (content: string, options: { streaming: boolean }) => void;
  disabled: boolean;
}) {
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [input]);

  const handleSend = useCallback(() => {
    if (!input.trim() || disabled) return;
    const content = input.trim();
    setInput('');
    onSend(content, { streaming });
  }, [input, onSend, streaming, disabled]);

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
    <div className="mx-auto w-full max-w-3xl px-6 pb-4">
      <div className="relative flex items-end gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-2.5 shadow-lg transition focus-within:border-zinc-700">
        {/* Streaming toggle */}
        <button
          onClick={() => setStreaming(!streaming)}
          title={streaming ? 'Streaming mode — tokens appear as they arrive' : 'Non-streaming mode — full response at once'}
          className={`flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium transition ${
            streaming
              ? 'bg-blue-600/15 text-blue-400'
              : 'text-zinc-600 hover:text-zinc-400'
          }`}
        >
          {streaming ? <Zap className="h-3.5 w-3.5" /> : <ZapOff className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{streaming ? 'Stream' : 'Batch'}</span>
        </button>

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Send a message…"
          rows={1}
          disabled={disabled}
          className="max-h-[200px] min-h-[24px] flex-1 resize-none bg-transparent py-1.5 text-[15px] text-zinc-100 outline-none placeholder:text-zinc-600 disabled:opacity-50"
        />

        {/* Send button */}
        <button
          onClick={handleSend}
          disabled={!input.trim() || disabled}
          className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition ${
            !input.trim() || disabled
              ? 'cursor-not-allowed bg-zinc-800 text-zinc-600'
              : 'bg-zinc-100 text-zinc-900 hover:bg-white'
          }`}
          aria-label="Send message"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>

      {/* Hint */}
      <p className="mt-2 text-center text-xs text-zinc-600">
        Press <kbd className="rounded border border-zinc-800 px-1 py-0.5 text-[10px]">Enter</kbd> to send · <kbd className="rounded border border-zinc-800 px-1 py-0.5 text-[10px]">Shift+Enter</kbd> for new line
      </p>
    </div>
  );
}
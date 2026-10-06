'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
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

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
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
    <div className="shrink-0 border-t border-border bg-background px-6 py-4">
      <div className="mx-auto w-full max-w-2xl space-y-3">
        <div className="flex gap-2">
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message"
            rows={1}
            disabled={disabled}
            className="min-h-[44px] flex-1 border-border bg-background shadow-none"
          />
          <Button
            type="button"
            onClick={handleSend}
            disabled={!input.trim() || disabled}
            className="shrink-0 self-end"
          >
            Send
          </Button>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={streaming}
            onChange={(e) => setStreaming(e.target.checked)}
            className="rounded border-border"
          />
          Stream response
        </label>
      </div>
    </div>
  );
}

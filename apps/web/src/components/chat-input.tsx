'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { ArrowUp } from 'lucide-react';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';
import { cn } from '../lib/utils';

export function ChatInput({
  onSend,
  disabled,
  variant = 'dock',
}: {
  onSend: (content: string, options: { streaming: boolean }) => void;
  disabled: boolean;
  variant?: 'dock' | 'hero';
}) {
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, variant === 'hero' ? 200 : 160)}px`;
  }, [input, variant]);

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

  const isHero = variant === 'hero';

  return (
    <div
      className={cn(
        'shrink-0',
        isHero
          ? 'w-full px-0 py-0'
          : 'border-t border-border/40 bg-background/70 px-4 py-4 backdrop-blur-md sm:px-6',
      )}
    >
      <div className={cn('mx-auto w-full max-w-3xl')}>
        <div
          className={cn(
            'relative rounded-2xl ring-1 ring-border/60 transition-shadow focus-within:ring-border',
            isHero
              ? 'bg-card/80 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]'
              : 'bg-card/60',
          )}
        >
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isHero ? 'Ask a research question…' : 'Message'}
            rows={1}
            disabled={disabled}
            className={cn(
              'min-h-13 resize-none border-0 bg-transparent px-4 pt-4 pb-12 text-[15px] shadow-none focus-visible:ring-0',
              isHero && 'min-h-14',
            )}
          />
          <div className="absolute inset-x-3 bottom-3 flex items-center justify-between gap-2">
            <label
              className={cn(
                'flex cursor-pointer items-center gap-1.5 rounded-full px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground',
              )}
            >
              <input
                type="checkbox"
                checked={streaming}
                onChange={(e) => setStreaming(e.target.checked)}
                className="size-3 rounded border-border accent-foreground"
              />
              Stream
            </label>
            <Button
              type="button"
              size="icon"
              onClick={handleSend}
              disabled={!input.trim() || disabled}
              className="size-8 shrink-0 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
              aria-label="Send message"
            >
              <ArrowUp className="size-4" strokeWidth={2.25} />
            </Button>
          </div>
        </div>
        {isHero && (
          <p className="mt-4 text-center text-xs text-muted-foreground/70">
            Threads are saved locally when you send your first message.
          </p>
        )}
      </div>
    </div>
  );
}

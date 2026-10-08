'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { ArrowUp, Pencil, Plus } from 'lucide-react';
import type { ComposerOptions } from '@/features/agent/api/agent-client';
import type { QueuedMessage } from '@/features/agent/hooks/use-agent-run';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
} from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export function ChatInput({
  onSend,
  isRunning,
  queuedMessage,
  onSendQueuedNow,
  onEditQueued,
  composerOptions,
  onComposerOptionsChange,
  variant = 'dock',
}: {
  onSend: (content: string, options: ComposerOptions) => void;
  isRunning: boolean;
  queuedMessage: QueuedMessage | null;
  onSendQueuedNow: () => void;
  onEditQueued: () => string | null;
  composerOptions: ComposerOptions;
  onComposerOptionsChange: (options: ComposerOptions) => void;
  variant?: 'dock' | 'hero';
}) {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, variant === 'hero' ? 200 : 160)}px`;
  }, [input, variant]);

  const handleSend = useCallback(() => {
    if (!input.trim()) return;
    const content = input.trim();
    setInput('');
    onSend(content, composerOptions);
  }, [input, onSend, composerOptions]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleEditQueued = useCallback(() => {
    const text = onEditQueued();
    if (text) setInput(text);
    textareaRef.current?.focus();
  }, [onEditQueued]);

  const isHero = variant === 'hero';

  return (
    <div
      className={cn(
        'shrink-0',
        isHero
          ? 'w-full px-0 py-0'
          : 'border-t border-border/25 bg-background/85 px-4 py-3 backdrop-blur-sm sm:px-6',
      )}
    >
      <div className="mx-auto w-full max-w-3xl space-y-2">
        {queuedMessage && (
          <Card
            size="sm"
            className="ring-border/60"
            role="status"
            aria-live="polite"
          >
            <CardHeader className="border-b border-border/40 pb-2">
              <Badge variant="secondary" className="font-normal">
                1 queued
              </Badge>
              <CardAction className="flex gap-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs"
                  onClick={handleEditQueued}
                >
                  <Pencil className="size-3" aria-hidden />
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => void onSendQueuedNow()}
                >
                  Send immediately
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent>
              <p className="line-clamp-2 text-sm text-muted-foreground">
                {queuedMessage.content}
              </p>
            </CardContent>
          </Card>
        )}

        <Card
          className={cn(
            'gap-0 border border-border/40 bg-card/90 py-0 shadow-none ring-0 focus-within:border-border/60',
            isHero && 'bg-card',
          )}
        >
          <CardContent className="relative p-0">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isHero
                  ? 'Ask a research question…'
                  : isRunning
                    ? 'Send follow-up…'
                    : 'Message'
              }
              rows={1}
              className={cn(
                'min-h-13 resize-none rounded-lg border-0 bg-transparent py-3 pl-12 pr-14 text-[14px] shadow-none placeholder:text-muted-foreground/75 focus-visible:ring-0',
                isHero && 'min-h-14',
              )}
            />
            <div className="absolute bottom-2.5 left-2.5">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="rounded-full"
                    aria-label="Composer options"
                  >
                    <Plus className="size-4" strokeWidth={2.25} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-52">
                  <DropdownMenuLabel>Composer</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuCheckboxItem
                    checked={composerOptions.streaming}
                    onCheckedChange={(checked) =>
                      onComposerOptionsChange({
                        ...composerOptions,
                        streaming: checked === true,
                      })
                    }
                  >
                    Stream response
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuCheckboxItem
                    checked={composerOptions.webSearch}
                    onCheckedChange={(checked) =>
                      onComposerOptionsChange({
                        ...composerOptions,
                        webSearch: checked === true,
                      })
                    }
                  >
                    Web search tool
                  </DropdownMenuCheckboxItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="absolute right-2.5 bottom-2.5">
              <Button
                type="button"
                size="icon-sm"
                onClick={handleSend}
                disabled={!input.trim()}
                className="rounded-full"
                aria-label="Send message"
              >
                <ArrowUp className="size-4" strokeWidth={2.25} />
              </Button>
            </div>
          </CardContent>
        </Card>

        {isHero && (
          <p className="text-center text-xs text-muted-foreground/70">
            Threads are saved locally when you send your first message.
          </p>
        )}
      </div>
    </div>
  );
}

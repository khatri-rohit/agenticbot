'use client';

import { useCallback, useState } from 'react';
import { Check, Copy, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export function MessageActions({
  content,
  align = 'start',
  showRetry = false,
  onRetry,
  disabled = false,
  className,
}: {
  content: string;
  align?: 'start' | 'end';
  showRetry?: boolean;
  onRetry?: () => void | Promise<void>;
  disabled?: boolean;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmRetry, setConfirmRetry] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const handleCopy = useCallback(async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard denied */
    }
  }, [content]);

  const handleConfirmRetry = useCallback(async () => {
    if (!onRetry) return;
    setRetrying(true);
    try {
      await onRetry();
      setConfirmRetry(false);
    } finally {
      setRetrying(false);
    }
  }, [onRetry]);

  return (
    <div
      className={cn(
        'mt-1 flex flex-wrap items-center gap-0.5',
        align === 'end' ? 'justify-end' : 'justify-start',
        className,
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => void handleCopy()}
            disabled={!content.trim()}
          >
            {copied ? (
              <Check className="size-3.5" aria-hidden />
            ) : (
              <Copy className="size-3.5" aria-hidden />
            )}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Copy message</TooltipContent>
      </Tooltip>

      {showRetry && !confirmRetry && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => setConfirmRetry(true)}
              disabled={disabled || retrying}
            >
              <RotateCcw className="size-3.5" aria-hidden />
              Retry
            </Button>
          </TooltipTrigger>
          <TooltipContent>Regenerate this response</TooltipContent>
        </Tooltip>
      )}

      {showRetry && confirmRetry && (
        <div
          className="flex flex-wrap items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-2 py-1"
          role="status"
        >
          <span className="text-xs text-muted-foreground">
            Retry this response?
          </span>
          <Button
            type="button"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={retrying}
            onClick={() => void handleConfirmRetry()}
          >
            {retrying ? 'Retrying…' : 'Yes, retry'}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            disabled={retrying}
            onClick={() => setConfirmRetry(false)}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

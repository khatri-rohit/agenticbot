'use client';

import { formatTokenCount } from '@/lib/estimate-tokens';
import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

export function ContextUsage({
  used,
  limit,
}: {
  used: number;
  limit: number | null;
}) {
  if (limit == null || limit <= 0) return null;

  const ratio = Math.min(1, Math.max(0, used / limit));
  const percent = Math.round(ratio * 100);
  const size = 20;
  const stroke = 2.25;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - ratio);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={`${percent}% context used, ${formatTokenCount(used)} of ${formatTokenCount(limit)} tokens`}
        >
          <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className="-rotate-90"
            aria-hidden
          >
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              className="stroke-muted-foreground/25"
              strokeWidth={stroke}
            />
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              className={cn(
                'transition-[stroke-dashoffset] duration-500 ease-out',
                ratio >= 0.92
                  ? 'stroke-destructive'
                  : ratio >= 0.75
                    ? 'stroke-amber-500'
                    : 'stroke-foreground/70',
              )}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={circumference}
              strokeDashoffset={offset}
            />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-44 p-2.5">
        <p className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Context
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Used</dt>
          <dd className="text-right font-medium tabular-nums">
            {formatTokenCount(used)}
          </dd>
          <dt className="text-muted-foreground">Limit</dt>
          <dd className="text-right font-medium tabular-nums">
            {formatTokenCount(limit)}
          </dd>
        </dl>
        <p className="mt-2 text-[11px] text-muted-foreground tabular-nums">
          {percent}% of window
        </p>
      </PopoverContent>
    </Popover>
  );
}

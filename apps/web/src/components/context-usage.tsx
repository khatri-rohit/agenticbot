'use client';

import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { ContextReportLayer } from '@agent/agent-models';
import type { ContextMeterSource } from '@/features/agent/hooks/use-context-meter';

export function ContextUsage({
  used,
  limit,
  source,
  approximate,
  layers = [],
}: {
  used: number;
  limit: number | null;
  source: ContextMeterSource;
  approximate: boolean;
  layers?: ContextReportLayer[];
}) {
  if (limit == null || limit <= 0) return null;

  const ratio = Math.min(1, Math.max(0, used / limit));
  const percent = Math.round(ratio * 100);
  const usedLabel = used.toLocaleString();
  const limitLabel = limit.toLocaleString();
  const showTilde = source === 'estimate' || approximate;
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
          aria-label={`${showTilde ? 'About ' : ''}${percent}% context used, ${usedLabel} of ${limitLabel} tokens, ${source}`}
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
      <PopoverContent align="end" side="top" className="w-52 p-2.5">
        <p className="mb-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Context
        </p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Used</dt>
          <dd className="text-right font-medium tabular-nums">
            {showTilde ? '~' : ''}
            {usedLabel}
          </dd>
          <dt className="text-muted-foreground">Limit</dt>
          <dd className="text-right font-medium tabular-nums">{limitLabel}</dd>
          {layers
            .filter((layer) => layer.tokens > 0)
            .map((layer) => (
              <div key={layer.id} className="contents">
                <dt className="text-muted-foreground">{layer.label}</dt>
                <dd className="text-right tabular-nums">
                  {layer.tokens.toLocaleString()}
                </dd>
              </div>
            ))}
        </dl>
        <p className="mt-2 text-[11px] text-muted-foreground tabular-nums">
          {showTilde ? '~' : ''}
          {percent}% of window
        </p>
      </PopoverContent>
    </Popover>
  );
}

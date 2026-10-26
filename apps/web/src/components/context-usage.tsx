'use client';

import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type {
  ContextReportLayer,
  ContextWindowSource,
} from '@agent/agent-models';
import type { ContextMeterSource } from '@/features/agent/hooks/use-context-meter';

const BUCKETS: {
  id: string;
  label: string;
  layerIds: readonly string[];
  barClass: string;
}[] = [
  {
    id: 'system',
    label: 'System',
    layerIds: ['system'],
    barClass: 'bg-foreground/80',
  },
  {
    id: 'tools',
    label: 'Tools',
    layerIds: ['tools'],
    barClass: 'bg-foreground/55',
  },
  {
    id: 'rules',
    label: 'Rules & memory',
    layerIds: [
      'skills_catalog',
      'skills_bodies',
      'memory',
      'rules',
      'plan',
      'mentions',
      'brief',
    ],
    barClass: 'bg-foreground/35',
  },
  {
    id: 'conversation',
    label: 'Conversation',
    layerIds: ['conversation', 'skills_loaded'],
    barClass: 'bg-foreground',
  },
];

function tokensFor(
  layers: ContextReportLayer[],
  ids: readonly string[],
): number {
  const idSet = new Set(ids);
  return layers.reduce(
    (sum, layer) => (idSet.has(layer.id) ? sum + layer.tokens : sum),
    0,
  );
}

export function ContextUsage({
  used,
  limit,
  source,
  approximate,
  layers = [],
  reserve = 0,
  windowSource,
}: {
  used: number;
  limit: number | null;
  source: ContextMeterSource;
  approximate: boolean;
  layers?: ContextReportLayer[];
  reserve?: number;
  windowSource?: ContextWindowSource;
}) {
  if (limit == null || limit <= 0) return null;

  const ratio = Math.min(1, Math.max(0, used / limit));
  const percent = Math.round(ratio * 100);
  const usedLabel = used.toLocaleString();
  const limitLabel = limit.toLocaleString();
  const showTilde = source === 'estimate' || approximate;
  const defaultWindow = windowSource === 'default';
  const size = 20;
  const stroke = 2.25;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - ratio);
  const free = Math.max(0, limit - used - reserve);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={`${showTilde ? 'About ' : ''}${percent}% context used, ${usedLabel} of ${limitLabel} tokens, ${source}${defaultWindow ? ', default window' : ''}`}
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
                    ? 'stroke-[var(--warning)]'
                    : 'stroke-foreground/70',
              )}
              strokeWidth={stroke}
              strokeDasharray={circumference}
              strokeDashoffset={offset}
              strokeLinecap="round"
            />
          </svg>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-64 p-2.5">
        <p className="type-caption mb-2 font-medium text-muted-foreground">
          Context
        </p>
        <div
          className="mb-2 flex h-1.5 overflow-hidden rounded-full bg-muted"
          aria-hidden
        >
          {BUCKETS.map((bucket) => {
            const tokens = tokensFor(layers, bucket.layerIds);
            if (tokens <= 0) return null;
            return (
              <div
                key={bucket.id}
                className={bucket.barClass}
                style={{ width: `${(tokens / limit) * 100}%` }}
              />
            );
          })}
          {reserve > 0 ? (
            <div
              className="bg-muted-foreground/25"
              style={{ width: `${(reserve / limit) * 100}%` }}
            />
          ) : null}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Used</dt>
          <dd className="text-right font-medium tabular-nums">
            {showTilde ? '~' : ''}
            {usedLabel}
          </dd>
          {BUCKETS.map((bucket) => {
            const tokens = tokensFor(layers, bucket.layerIds);
            if (tokens <= 0) return null;
            const kids = layers.filter(
              (layer) =>
                bucket.layerIds.includes(layer.id) && layer.tokens > 0,
            );
            return (
              <div key={bucket.id} className="contents">
                <dt className="text-muted-foreground">{bucket.label}</dt>
                <dd className="text-right tabular-nums">
                  {tokens.toLocaleString()}
                </dd>
                {kids.length > 1
                  ? kids.map((layer) => (
                      <div key={layer.id} className="contents">
                        <dt className="pl-2 text-muted-foreground/80">
                          {layer.label}
                        </dt>
                        <dd className="text-right tabular-nums text-muted-foreground">
                          {layer.tokens.toLocaleString()}
                        </dd>
                      </div>
                    ))
                  : null}
              </div>
            );
          })}
          {reserve > 0 ? (
            <>
              <dt className="text-muted-foreground">Reserve</dt>
              <dd className="text-right tabular-nums">
                {reserve.toLocaleString()}
              </dd>
            </>
          ) : null}
          <dt className="text-muted-foreground">Free</dt>
          <dd className="text-right tabular-nums">{free.toLocaleString()}</dd>
          <dt className="text-muted-foreground">Limit</dt>
          <dd className="text-right font-medium tabular-nums">{limitLabel}</dd>
        </dl>
        {defaultWindow ? (
          <p className="type-caption mt-2 text-muted-foreground">
            Using default window — model show unavailable
          </p>
        ) : null}
        <p className="type-caption mt-2 text-muted-foreground tabular-nums">
          {showTilde ? '~' : ''}
          {percent}% of window
        </p>
      </PopoverContent>
    </Popover>
  );
}

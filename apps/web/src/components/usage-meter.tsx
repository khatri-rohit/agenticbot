'use client';

import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { OllamaBalance } from '@agent/agent-models';

const size = 20;
const stroke = 2.25;
const radius = (size - stroke) / 2;
const circumference = 2 * Math.PI * radius;

/**
 * The ratio to show in the ring: used / total (0–1).
 * Legacy: the tighter of session/weekly remaining → used = 1 - remaining.
 * Modern: used = allowance - balance / allowance.
 */
function usedRatio(balance: OllamaBalance): number | null {
  if (balance.legacy) {
    const sessionUsed = 1 - balance.legacy.session.remainingPercent / 100;
    const weeklyUsed = 1 - balance.legacy.weekly.remainingPercent / 100;
    return Math.max(sessionUsed, weeklyUsed);
  }
  if (balance.modern && balance.modern.allowanceUsd > 0) {
    return Math.min(
      1,
      Math.max(0, 1 - balance.modern.balanceUsd / balance.modern.allowanceUsd),
    );
  }
  return null;
}

function ringClass(ratio: number): string {
  if (ratio >= 0.92) return 'stroke-destructive';
  if (ratio >= 0.75) return 'stroke-[var(--warning)]';
  return 'stroke-foreground/70';
}

function formatReset(iso: string): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function UsageMeter({
  balance,
  loading,
}: {
  balance: OllamaBalance | null;
  loading: boolean;
}) {
  if (loading && !balance) {
    return (
      <span className="inline-flex size-7 items-center justify-center text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" strokeWidth={2.25} />
      </span>
    );
  }

  if (!balance || (!balance.legacy && !balance.modern)) return null;

  const ratio = usedRatio(balance);
  if (ratio == null) return null;

  const clamped = Math.min(1, Math.max(0, ratio));
  const offset = circumference * (1 - clamped);

  const ariaLabel = balance.legacy
    ? `Session ${balance.legacy.session.remainingPercent}% remaining, weekly ${balance.legacy.weekly.remainingPercent}% remaining`
    : balance.modern
      ? `${formatUsd(balance.modern.balanceUsd)} of ${formatUsd(balance.modern.allowanceUsd)} remaining`
      : 'Usage';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
          aria-label={ariaLabel}
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
                ringClass(clamped),
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
          Ollama Cloud Usage
        </p>
        {balance.legacy ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Session</dt>
            <dd className="text-right font-medium tabular-nums">
              {balance.legacy.session.remainingPercent}% left
            </dd>
            <dt className="text-muted-foreground">Session resets</dt>
            <dd className="text-right tabular-nums">
              {formatReset(balance.legacy.session.resetsAt)}
            </dd>
            <dt className="text-muted-foreground">Weekly</dt>
            <dd className="text-right font-medium tabular-nums">
              {balance.legacy.weekly.remainingPercent}% left
            </dd>
            <dt className="text-muted-foreground">Weekly resets</dt>
            <dd className="text-right tabular-nums">
              {formatReset(balance.legacy.weekly.resetsAt)}
            </dd>
          </dl>
        ) : balance.modern ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Remaining</dt>
            <dd className="text-right font-medium tabular-nums">
              {formatUsd(balance.modern.balanceUsd)}
            </dd>
            <dt className="text-muted-foreground">Allowance</dt>
            <dd className="text-right tabular-nums">
              {formatUsd(balance.modern.allowanceUsd)}
            </dd>
            <dt className="text-muted-foreground">Used</dt>
            <dd className="text-right tabular-nums">
              {formatUsd(
                balance.modern.allowanceUsd - balance.modern.balanceUsd,
              )}
            </dd>
            <dt className="text-muted-foreground">Resets</dt>
            <dd className="text-right tabular-nums">
              {formatReset(balance.modern.period.until)}
            </dd>
          </dl>
        ) : null}
        {typeof balance.purchasedUsd === 'number' ? (
          <p className="type-caption mt-2 text-muted-foreground">
            Purchased credits: {formatUsd(balance.purchasedUsd)}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
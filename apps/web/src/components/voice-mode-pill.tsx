'use client';

import { cn } from '@/lib/utils';

const BAR_COUNT = 5;

/**
 * Clean rounded pill shown while voice dictation is on.
 * Bars scale with mic level (RMS), approximating pitch/energy.
 */
export function VoiceModePill({
  level,
  className,
}: {
  level: number;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(1, level));

  return (
    <span
      role="status"
      aria-live="polite"
      aria-label="Voice mode on"
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full border border-border/60 bg-muted/80 px-2.5 text-xs font-medium text-foreground',
        className,
      )}
    >
      <span className="flex h-3.5 items-end gap-0.5" aria-hidden>
        {Array.from({ length: BAR_COUNT }, (_, i) => {
          // Center bar reacts strongest; edges softer
          const weight = 1 - Math.abs(i - (BAR_COUNT - 1) / 2) * 0.28;
          const h = 22 + clamped * weight * 78;
          return (
            <span
              key={i}
              className="w-0.5 rounded-full bg-foreground/80 transition-[height] duration-75 ease-out"
              style={{ height: `${h}%` }}
            />
          );
        })}
      </span>
      <span>Voice</span>
      <span className="text-muted-foreground">Alt+A</span>
    </span>
  );
}

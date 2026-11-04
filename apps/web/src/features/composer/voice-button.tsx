'use client';

import { Loader2, Mic } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { VoiceInputController } from './use-voice-input';

const WAVE_BAR_COUNT = 5;

/** Compact waveform that fits inside the mic button while voice is active. */
function MicWaveform({ level }: { level: number }) {
  const clamped = Math.max(0, Math.min(1, level));
  return (
    <span className="flex h-4 items-end gap-0.5" aria-hidden>
      {Array.from({ length: WAVE_BAR_COUNT }, (_, i) => {
        const weight = 1 - Math.abs(i - (WAVE_BAR_COUNT - 1) / 2) * 0.28;
        const h = 22 + clamped * weight * 78;
        return (
          <span
            key={i}
            className="w-0.5 rounded-full bg-current transition-[height] duration-75 ease-out"
            style={{ height: `${h}%` }}
          />
        );
      })}
    </span>
  );
}

/** Mic toggle: idle mic, live waveform while listening, spinner while transcribing. */
export function VoiceButton({ voice }: { voice: VoiceInputController }) {
  return (
    <Button
      type="button"
      size="icon-sm"
      variant={voice.active || voice.transcribing ? 'secondary' : 'ghost'}
      onClick={() => voice.toggle()}
      aria-label={
        voice.transcribing
          ? 'Transcribing voice'
          : voice.active
            ? 'Stop voice mode'
            : 'Start voice mode'
      }
      aria-pressed={voice.active}
      aria-busy={voice.transcribing}
      title={voice.transcribing ? 'Transcribing…' : 'Voice mode'}
      className={cn(
        'shrink-0 rounded-full',
        (voice.active || voice.transcribing) && 'text-foreground',
        voice.active && 'w-auto px-2',
      )}
    >
      {voice.active ? (
        <MicWaveform level={voice.level} />
      ) : voice.transcribing ? (
        <Loader2 className="size-4 animate-spin" strokeWidth={2.25} />
      ) : (
        <Mic className="size-4" strokeWidth={2.25} />
      )}
    </Button>
  );
}

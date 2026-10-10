'use client';

import { useBrowserSpeechDictation } from '@/features/agent/hooks/use-browser-speech-dictation';
import { useVoiceDictation } from '@/features/agent/hooks/use-voice-dictation';

type VoiceSttProvider = 'browser' | 'speaches' | 'off';

const VOICE_PROVIDERS = new Set<VoiceSttProvider>([
  'browser',
  'speaches',
  'off',
]);

/** Default `browser` so forks work without Docker / Speaches / GPU. */
function resolveVoiceSttProvider(): VoiceSttProvider {
  const raw = (process.env.NEXT_PUBLIC_VOICE_STT_PROVIDER ?? 'browser')
    .trim()
    .toLowerCase();
  if (VOICE_PROVIDERS.has(raw as VoiceSttProvider)) {
    return raw as VoiceSttProvider;
  }
  return 'browser';
}

type VoiceInputController = {
  enabled: boolean;
  provider: VoiceSttProvider;
  active: boolean;
  level: number;
  transcribing: boolean;
  error: string | null;
  toggle: () => void;
  stop: () => void;
};

const idleToggle = () => undefined;
const idleStop = () => undefined;

type Options = {
  onTranscript: (text: string) => void;
};

/**
 * Composer voice entrypoint. Provider comes from NEXT_PUBLIC_VOICE_STT_PROVIDER:
 * - browser  — Web Speech API (default; no Docker)
 * - speaches — local Speaches via apps/api
 * - off      — hide voice UI
 */
export function useVoiceInput({ onTranscript }: Options): VoiceInputController {
  const provider = resolveVoiceSttProvider();

  const speaches = useVoiceDictation({
    onTranscript,
    enabled: provider === 'speaches',
  });

  const browser = useBrowserSpeechDictation({
    onTranscript,
    enabled: provider === 'browser',
  });

  if (provider === 'off') {
    return {
      enabled: false,
      provider,
      active: false,
      level: 0,
      transcribing: false,
      error: null,
      toggle: idleToggle,
      stop: idleStop,
    };
  }

  if (provider === 'browser') {
    return {
      enabled: true,
      provider,
      active: browser.active,
      level: browser.level,
      transcribing: browser.transcribing,
      error: browser.error,
      toggle: browser.toggle,
      stop: browser.stop,
    };
  }

  return {
    enabled: true,
    provider,
    active: speaches.active,
    level: speaches.level,
    transcribing: speaches.transcribing,
    error: speaches.error,
    toggle: speaches.toggle,
    stop: speaches.stop,
  };
}

export type VoiceSttProvider = 'browser' | 'speaches' | 'off';

const PROVIDERS = new Set<VoiceSttProvider>(['browser', 'speaches', 'off']);

/**
 * Voice STT backend for the web app.
 * Default `browser` so forks work without Docker / Speaches / GPU.
 */
export function getVoiceSttProvider(): VoiceSttProvider {
  const raw = (process.env.NEXT_PUBLIC_VOICE_STT_PROVIDER ?? 'browser')
    .trim()
    .toLowerCase();
  if (PROVIDERS.has(raw as VoiceSttProvider)) {
    return raw as VoiceSttProvider;
  }
  return 'browser';
}

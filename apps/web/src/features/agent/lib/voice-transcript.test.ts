import { describe, expect, it } from 'vitest';
import { isUsableTranscript } from './voice-transcript';

describe('isUsableTranscript', () => {
  it('accepts normal speech', () => {
    expect(isUsableTranscript('queue the title job')).toBe(true);
  });

  it('rejects empty and pipe spam', () => {
    expect(isUsableTranscript('')).toBe(false);
    expect(isUsableTranscript('||| ||| |||')).toBe(false);
  });

  it('rejects common silence hallucinations', () => {
    expect(isUsableTranscript('Thanks for watching!')).toBe(false);
    expect(isUsableTranscript('Thank you for watching')).toBe(false);
    expect(isUsableTranscript('80,000 Thanks for watching!')).toBe(false);
  });
});

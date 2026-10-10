'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeAudio } from '@/features/agent/api/voice-client';
import { isUsableTranscript } from '@/features/agent/lib/voice-transcript';

/** Mic energy sample interval. */
const VAD_TICK_MS = 80;
/** RMS above this counts as speech. */
const SPEECH_RMS = 0.02;
/** End a chunk after this much silence (while listening). */
const SILENCE_AFTER_SPEECH_MS = 700;
/** Ignore trailing silence until the chunk has this much audio. */
const MIN_SPEECH_MS = 280;
/**
 * Force-cut a chunk while the user is still talking so STT starts early
 * (near-realtime), instead of waiting for a long pause or a 10s cap.
 */
const FORCE_CHUNK_MS = 2_000;
const MIN_BLOB_BYTES = 1_200;

type MicSession = {
  stream: MediaStream;
  ctx: AudioContext;
  analyser: AnalyserNode;
  mimeType: string;
  /** Ends listening only — does not cancel in-flight STT. */
  listenAbort: AbortController;
};

function pickMimeType(): string {
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
    return 'audio/webm;codecs=opus';
  }
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
  return 'audio/mp4';
}

function readRms(analyser: AnalyserNode): number {
  const data = new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = ((data[i] ?? 128) - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const onAbort = () => {
      clearTimeout(id);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const id = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function waitForSpeech(
  session: MicSession,
): Promise<'speech' | 'aborted'> {
  const { signal } = session.listenAbort;
  while (!signal.aborted) {
    if (readRms(session.analyser) >= SPEECH_RMS) return 'speech';
    try {
      await sleep(VAD_TICK_MS, signal);
    } catch {
      return 'aborted';
    }
  }
  return 'aborted';
}

/**
 * Record until silence, force-chunk, or listen-stop.
 * On listen-stop, flushes the current recorder so the last words are kept.
 */
function recordChunk(session: MicSession): Promise<Blob | null> {
  return new Promise((resolve) => {
    const { signal } = session.listenAbort;
    if (signal.aborted) {
      resolve(null);
      return;
    }

    let recorder: MediaRecorder;
    try {
      recorder = MediaRecorder.isTypeSupported(session.mimeType)
        ? new MediaRecorder(session.stream, { mimeType: session.mimeType })
        : new MediaRecorder(session.stream);
    } catch {
      resolve(null);
      return;
    }

    const chunks: BlobPart[] = [];
    const startedAt = performance.now();
    let silenceMs = 0;
    let vadTimer: ReturnType<typeof setInterval> | null = null;
    let maxTimer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const cleanup = () => {
      if (vadTimer) clearInterval(vadTimer);
      if (maxTimer) clearTimeout(maxTimer);
      signal.removeEventListener('abort', onAbort);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      if (recorder.state === 'recording') {
        try {
          recorder.stop();
        } catch {
          resolve(null);
        }
      } else {
        resolve(null);
      }
    };

    const onAbort = () => finish();

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, {
        type: recorder.mimeType || session.mimeType,
      });
      resolve(blob.size >= MIN_BLOB_BYTES ? blob : null);
    };

    recorder.onerror = () => {
      cleanup();
      resolve(null);
    };

    signal.addEventListener('abort', onAbort, { once: true });
    recorder.start();
    maxTimer = setTimeout(finish, FORCE_CHUNK_MS);

    vadTimer = setInterval(() => {
      if (signal.aborted) {
        finish();
        return;
      }
      if (readRms(session.analyser) >= SPEECH_RMS) {
        silenceMs = 0;
        return;
      }
      if (performance.now() - startedAt < MIN_SPEECH_MS) return;
      silenceMs += VAD_TICK_MS;
      if (silenceMs >= SILENCE_AFTER_SPEECH_MS) finish();
    }, VAD_TICK_MS);
  });
}

function releaseMic(session: MicSession) {
  session.stream.getTracks().forEach((t) => t.stop());
  void session.ctx.close().catch(() => undefined);
}

type VoiceDictationOptions = {
  onTranscript: (text: string) => void;
  /** When false, hook is idle (no mic, no Alt+A). */
  enabled?: boolean;
};

/**
 * Speaches push-to-talk dictation (MediaRecorder → /api/voice/transcribe).
 * Short chunks while speaking; stop ends listening only (STT still drains).
 */
export function useVoiceDictation({
  onTranscript,
  enabled = true,
}: VoiceDictationOptions) {
  const [active, setActive] = useState(false);
  const [level, setLevel] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<MicSession | null>(null);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;
  const meterRafRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const pendingRef = useRef(0);
  /** Serial Speaches chain — one request at a time. */
  const sttChainRef = useRef(Promise.resolve());

  const stopMeter = useCallback(() => {
    if (meterRafRef.current != null) {
      cancelAnimationFrame(meterRafRef.current);
      meterRafRef.current = null;
    }
    setLevel(0);
  }, []);

  const startMeter = useCallback(() => {
    const tick = () => {
      const session = sessionRef.current;
      if (!session) return;
      setLevel(Math.min(1, readRms(session.analyser) * 3.2));
      meterRafRef.current = requestAnimationFrame(tick);
    };
    meterRafRef.current = requestAnimationFrame(tick);
  }, []);

  const enqueueTranscribe = useCallback((blob: Blob) => {
    pendingRef.current += 1;
    setTranscribing(true);

    const run = async () => {
      try {
        if (!mountedRef.current) return;
        const text = await transcribeAudio(blob);
        if (!mountedRef.current) return;
        if (isUsableTranscript(text)) onTranscriptRef.current(text);
        setError(null);
      } catch (err: unknown) {
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : 'Transcription failed');
      } finally {
        pendingRef.current = Math.max(0, pendingRef.current - 1);
        if (mountedRef.current) setTranscribing(pendingRef.current > 0);
      }
    };

    // One Speaches request at a time; onRejected also runs so the queue continues.
    sttChainRef.current = sttChainRef.current.then(run, run);
  }, []);

  const runLoop = useCallback(
    async (session: MicSession) => {
      try {
        while (
          !session.listenAbort.signal.aborted &&
          sessionRef.current === session
        ) {
          const gate = await waitForSpeech(session);
          if (gate === 'aborted') break;

          const blob = await recordChunk(session);
          if (blob) enqueueTranscribe(blob);

          // After Alt+A off, recordChunk flushes then abort is set — exit.
          if (session.listenAbort.signal.aborted) break;
        }
      } finally {
        releaseMic(session);
        if (sessionRef.current === session) {
          sessionRef.current = null;
        }
      }
    },
    [enqueueTranscribe],
  );

  const stop = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;

    // End listening immediately; STT drain keeps running via enqueueTranscribe.
    sessionRef.current = null;
    setActive(false);
    stopMeter();
    session.listenAbort.abort();
  }, [stopMeter]);

  const start = useCallback(async () => {
    if (!enabled || sessionRef.current) return;
    setError(null);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctx();
      if (ctx.state === 'suspended') await ctx.resume();

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);

      const session: MicSession = {
        stream,
        ctx,
        analyser,
        mimeType: pickMimeType(),
        listenAbort: new AbortController(),
      };

      sessionRef.current = session;
      setActive(true);
      startMeter();
      void runLoop(session);
    } catch {
      setError('Microphone permission denied or unavailable');
      setActive(false);
      stopMeter();
    }
  }, [enabled, runLoop, startMeter, stopMeter]);

  const toggle = useCallback(() => {
    if (sessionRef.current) stop();
    else void start();
  }, [start, stop]);

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key !== 'a' && e.key !== 'A') return;
      if (e.repeat) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, toggle]);

  useEffect(() => {
    if (enabled) return;
    stop();
  }, [enabled, stop]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const session = sessionRef.current;
      sessionRef.current = null;
      if (meterRafRef.current != null) {
        cancelAnimationFrame(meterRafRef.current);
      }
      if (session) {
        session.listenAbort.abort();
        releaseMic(session);
      }
    };
  }, []);

  return { active, level, transcribing, error, toggle, stop };
}

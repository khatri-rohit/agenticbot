'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { transcribeAudio } from '@/features/agent/api/voice-client';

const SEGMENT_MS = 4000;
const MIN_BLOB_BYTES = 1200;

type VoiceDictationOptions = {
  /** Append finalized transcript text into the composer. */
  onTranscript: (text: string) => void;
};

/**
 * Alt+A toggles continuous voice dictation.
 * While on: mic stays open, short MediaRecorder segments are transcribed
 * via Speaches, and level (0–1) drives the wave pill.
 */
export function useVoiceDictation({ onTranscript }: VoiceDictationOptions) {
  const [active, setActive] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const activeRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const rafRef = useRef<number | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const segmentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mimeTypeRef = useRef('audio/webm');

  const stopLevelMeter = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setLevel(0);
  }, []);

  const startLevelMeter = useCallback(() => {
    const analyser = analyserRef.current;
    if (!analyser) return;
    const data = new Uint8Array(analyser.fftSize);

    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i]! - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      // Soft curve so quiet speech still moves the wave a bit
      setLevel(Math.min(1, rms * 3.2));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, []);

  const clearSegmentTimer = () => {
    if (segmentTimerRef.current != null) {
      clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = null;
    }
  };

  const stopRecorder = useCallback(() => {
    clearSegmentTimer();
    const rec = recorderRef.current;
    recorderRef.current = null;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        /* already stopped */
      }
    }
  }, []);

  const teardown = useCallback(() => {
    stopRecorder();
    stopLevelMeter();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    void audioCtxRef.current?.close().catch(() => undefined);
    audioCtxRef.current = null;
    analyserRef.current = null;
  }, [stopLevelMeter, stopRecorder]);

  const recordSegment = useCallback(() => {
    const stream = streamRef.current;
    if (!stream || !activeRef.current) return;

    const mimeType = mimeTypeRef.current;
    let recorder: MediaRecorder;
    try {
      recorder = MediaRecorder.isTypeSupported(mimeType)
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
    } catch {
      setError('Microphone recording is not supported in this browser');
      activeRef.current = false;
      setActive(false);
      teardown();
      return;
    }

    recorderRef.current = recorder;
    const chunks: BlobPart[] = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
      const blob = new Blob(chunks, {
        type: recorder.mimeType || mimeType,
      });
      const stillOn = activeRef.current;

      if (blob.size >= MIN_BLOB_BYTES) {
        void transcribeAudio(blob)
          .then((text) => {
            if (text) onTranscriptRef.current(text);
          })
          .catch((err: unknown) => {
            const msg =
              err instanceof Error ? err.message : 'Transcription failed';
            setError(msg);
          });
      }

      if (stillOn) {
        recordSegment();
      }
    };

    recorder.start();
    segmentTimerRef.current = setTimeout(() => {
      segmentTimerRef.current = null;
      if (recorderRef.current === recorder && recorder.state === 'recording') {
        recorder.stop();
      }
    }, SEGMENT_MS);
  }, [teardown]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      const Ctx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext })
          .webkitAudioContext;
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      analyserRef.current = analyser;

      mimeTypeRef.current = MediaRecorder.isTypeSupported(
        'audio/webm;codecs=opus',
      )
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/mp4';

      activeRef.current = true;
      setActive(true);
      startLevelMeter();
      recordSegment();
    } catch {
      setError('Microphone permission denied or unavailable');
      activeRef.current = false;
      setActive(false);
      teardown();
    }
  }, [recordSegment, startLevelMeter, teardown]);

  const stop = useCallback(() => {
    activeRef.current = false;
    setActive(false);
    stopRecorder();
    teardown();
  }, [stopRecorder, teardown]);

  const toggle = useCallback(() => {
    if (activeRef.current) stop();
    else void start();
  }, [start, stop]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key !== 'a' && e.key !== 'A') return;
      if (e.repeat) return;
      e.preventDefault();
      toggle();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);

  useEffect(() => () => teardown(), [teardown]);

  return { active, level, error, toggle, stop };
}

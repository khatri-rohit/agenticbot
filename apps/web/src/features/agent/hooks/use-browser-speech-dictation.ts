'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isUsableTranscript } from '@/features/agent/lib/voice-transcript';

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: BrowserSpeechResultEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};

type BrowserSpeechResultEvent = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

type SpeechRecognitionCtor = new () => BrowserSpeechRecognition;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

type Options = {
  onTranscript: (text: string) => void;
  enabled: boolean;
};

/**
 * Native Web Speech API dictation (no Speaches / Docker).
 * Best on Chromium; may use cloud STT depending on the browser.
 */
export function useBrowserSpeechDictation({ onTranscript, enabled }: Options) {
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const activeRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const stop = useCallback(() => {
    activeRef.current = false;
    setActive(false);
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return;
    try {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.stop();
    } catch {
      /* already stopped */
    }
  }, []);

  const start = useCallback(() => {
    if (!enabled || activeRef.current) return;

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setError('Speech recognition is not supported in this browser');
      return;
    }

    setError(null);
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result?.isFinal) continue;
        const text = result[0]?.transcript ?? '';
        if (isUsableTranscript(text)) onTranscriptRef.current(text);
      }
    };

    recognition.onerror = (event) => {
      if (event.error === 'aborted' || event.error === 'no-speech') return;
      setError(`Speech recognition error: ${event.error}`);
      stop();
    };

    recognition.onend = () => {
      // Browser may end the session on its own; keep listening while armed.
      if (!activeRef.current) return;
      try {
        recognition.start();
      } catch {
        stop();
      }
    };

    recognitionRef.current = recognition;
    activeRef.current = true;
    setActive(true);

    try {
      recognition.start();
    } catch {
      setError('Could not start speech recognition');
      stop();
    }
  }, [enabled, stop]);

  const toggle = useCallback(() => {
    if (activeRef.current) stop();
    else start();
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

  useEffect(() => () => stop(), [stop]);

  return {
    active,
    level: active ? 0.45 : 0,
    transcribing: false,
    error,
    toggle,
    stop,
  };
}

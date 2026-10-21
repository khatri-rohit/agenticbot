import type { AgentEvent } from '@agenticbot/agent-models';

const SOUND_KEY = 'agenticbot:alerts-sound';
const NOTIFY_KEY = 'agenticbot:alerts-notify';
const SEQ_KEY_PREFIX = 'agenticbot:alerts-seq:';
const CANCELLED_ERROR = 'Run cancelled';
const BODY_MAX = 140;

export type RunAlertKind = 'attention' | 'finished_ok' | 'finished_fail';

const seenKeys = new Set<string>();
let audioContext: AudioContext | null = null;

export function readSoundPref(): boolean {
  return readFlag(SOUND_KEY, true);
}

export function writeSoundPref(enabled: boolean): void {
  writeFlag(SOUND_KEY, enabled);
}

/** Play the finished chime so settings can confirm the sound. */
export function previewAlertSound(): void {
  playTone('finished_ok');
}

export function readNotifyPref(): boolean {
  return readFlag(NOTIFY_KEY, false);
}

export function writeNotifyPref(enabled: boolean): void {
  writeFlag(NOTIFY_KEY, enabled);
}

/** User-gesture entry: request OS permission, persist only if granted. */
export async function enableBrowserNotifications(): Promise<boolean> {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return false;
  }
  let permission = Notification.permission;
  if (permission === 'default') {
    permission = await Notification.requestPermission();
  }
  const granted = permission === 'granted';
  writeNotifyPref(granted);
  return granted;
}

/**
 * Advance the per-run seq watermark and fire sound/OS alerts for HITL pause
 * and true idle (settled / non-cancel error). Skips SSE replay and stale
 * subscriptions from a previous thread.
 */
export function observeRunEvent(input: {
  event: AgentEvent;
  subscribedRunId: string;
  subscribedThreadId: string;
  liveThreadId: string | null;
}): void {
  const { event, subscribedRunId, subscribedThreadId, liveThreadId } = input;
  if (liveThreadId !== subscribedThreadId) return;
  if (event.runId !== subscribedRunId) return;
  if (!shouldProcessSeq(event.runId, event.seq)) return;
  markObserved(event.runId, event.seq);

  const kind = classifyAlert(event);
  if (!kind) return;
  const dedupeKey = alertDedupeKey(kind, event);
  if (!dedupeKey || seenKeys.has(dedupeKey)) return;
  seenKeys.add(dedupeKey);

  if (readSoundPref()) {
    void playTone(kind);
  }
  showBrowserNotification(kind, event);
}

function classifyAlert(event: AgentEvent): RunAlertKind | null {
  if (event.type === 'choice.requested' || event.type === 'approval.requested') {
    return 'attention';
  }
  if (event.type === 'run.settled') return 'finished_ok';
  if (event.type === 'run.error' && event.error !== CANCELLED_ERROR) {
    return 'finished_fail';
  }
  return null;
}

function alertDedupeKey(kind: RunAlertKind, event: AgentEvent): string | null {
  if (event.type === 'choice.requested') {
    return `attention:${event.choiceId}`;
  }
  if (event.type === 'approval.requested') {
    return `attention:${event.approvalId}`;
  }
  if (kind === 'finished_ok' || kind === 'finished_fail') {
    return `finished:${event.runId}:${kind === 'finished_ok' ? 'ok' : 'fail'}`;
  }
  return null;
}

function shouldProcessSeq(runId: string, seq: number): boolean {
  return seq > readWatermark(runId);
}

function markObserved(runId: string, seq: number): void {
  const next = Math.max(readWatermark(runId), seq);
  writeSession(`${SEQ_KEY_PREFIX}${runId}`, String(next));
}

function readWatermark(runId: string): number {
  const raw = readSession(`${SEQ_KEY_PREFIX}${runId}`);
  if (!raw) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function playTone(kind: RunAlertKind): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  const start = () => {
    try {
      const now = ctx.currentTime;
      for (const note of chimeNotes(kind)) {
        scheduleBell(ctx, now + note.delay, note.hz, note.seconds);
      }
    } catch {
      /* context closed or node failed */
    }
  };
  if (ctx.state === 'suspended') {
    void ctx
      .resume()
      .then(start)
      .catch(() => {
        /* autoplay blocked until a later gesture */
      });
    return;
  }
  start();
}

/** Two-note interval: rising ping, resolving fifth, or falling minor. */
function chimeNotes(
  kind: RunAlertKind,
): ReadonlyArray<{ delay: number; hz: number; seconds: number }> {
  if (kind === 'attention') {
    return [
      { delay: 0, hz: 880, seconds: 0.14 },
      { delay: 0.11, hz: 1318.5, seconds: 0.32 },
    ];
  }
  if (kind === 'finished_ok') {
    return [
      { delay: 0, hz: 523.25, seconds: 0.16 },
      { delay: 0.13, hz: 783.99, seconds: 0.36 },
    ];
  }
  return [
    { delay: 0, hz: 493.88, seconds: 0.16 },
    { delay: 0.14, hz: 369.99, seconds: 0.34 },
  ];
}

function scheduleBell(
  ctx: AudioContext,
  time: number,
  hz: number,
  seconds: number,
): void {
  const master = ctx.createGain();
  master.connect(ctx.destination);
  master.gain.setValueAtTime(0.0001, time);
  master.gain.exponentialRampToValueAtTime(0.16, time + 0.018);
  master.gain.exponentialRampToValueAtTime(0.0001, time + seconds);

  const fundamental = ctx.createOscillator();
  fundamental.type = 'sine';
  fundamental.frequency.setValueAtTime(hz, time);
  fundamental.connect(master);

  const overtone = ctx.createOscillator();
  overtone.type = 'sine';
  overtone.frequency.setValueAtTime(hz * 2, time);
  const overtoneGain = ctx.createGain();
  overtoneGain.gain.setValueAtTime(0.18, time);
  overtone.connect(overtoneGain);
  overtoneGain.connect(master);

  fundamental.start(time);
  overtone.start(time);
  fundamental.stop(time + seconds + 0.02);
  overtone.stop(time + seconds + 0.02);
}

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (audioContext) return audioContext;
  const Ctor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  try {
    audioContext = new Ctor();
  } catch {
    return null;
  }
  return audioContext;
}

function showBrowserNotification(kind: RunAlertKind, event: AgentEvent): void {
  if (typeof window === 'undefined' || typeof Notification === 'undefined') {
    return;
  }
  if (!readNotifyPref() || Notification.permission !== 'granted') return;
  if (!isPageUnfocused()) return;

  const { title, body, tag } = notificationCopy(kind, event);
  try {
    const notification = new Notification(title, {
      body,
      tag,
      silent: true,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch {
    /* permission revoked between check and construct */
  }
}

function isPageUnfocused(): boolean {
  return document.hidden || !document.hasFocus();
}

function notificationCopy(
  kind: RunAlertKind,
  event: AgentEvent,
): { title: string; body: string; tag: string } {
  if (event.type === 'choice.requested') {
    return {
      title: 'Choice needed',
      body: clip(event.question),
      tag: `attention-${event.choiceId}`,
    };
  }
  if (event.type === 'approval.requested') {
    return {
      title: 'Answer needed',
      body: clip(event.summary),
      tag: `attention-${event.approvalId}`,
    };
  }
  if (kind === 'finished_ok') {
    return {
      title: 'Run finished',
      body: 'The agent is idle.',
      tag: `finished-${event.runId}`,
    };
  }
  const error =
    event.type === 'run.error' ? event.error : 'The run ended with an error.';
  return {
    title: 'Run failed',
    body: clip(error),
    tag: `finished-${event.runId}`,
  };
}

function clip(text: string): string {
  const compact = text.trim().replace(/\s+/g, ' ');
  if (compact.length <= BODY_MAX) return compact;
  return `${compact.slice(0, BODY_MAX - 1)}…`;
}

function readFlag(key: string, fallback: boolean): boolean {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return raw === '1';
  } catch {
    return fallback;
  }
}

function writeFlag(key: string, enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, enabled ? '1' : '0');
  } catch {
    /* storage blocked */
  }
}

function readSession(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
}

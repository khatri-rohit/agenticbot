'use client';

/** Synthetic MRU id for the home composer (new chat / draft). */
export const HOME_RECENT_ID = '__home__';

const STORAGE_KEY = 'agenticbot:recentThreads';
export const MAX_RECENT_THREADS = 10;

let ids: string[] = [];
let hydrated = false;

function readStored(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      )
      .slice(0, MAX_RECENT_THREADS);
  } catch {
    return [];
  }
}

function hydrate(): string[] {
  if (!hydrated && typeof window !== 'undefined') {
    ids = readStored();
    hydrated = true;
  }
  return ids;
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* private mode / quota */
  }
}

export function getRecentThreadIds(): string[] {
  return hydrate();
}

/** Bump a thread (or home) to the front of the MRU list. */
export function touchRecentThread(id: string): void {
  hydrate();
  const trimmed = id.trim();
  if (!trimmed) return;
  const next = [trimmed, ...ids.filter((item) => item !== trimmed)].slice(
    0,
    MAX_RECENT_THREADS,
  );
  if (next.length === ids.length && next.every((item, i) => item === ids[i])) {
    return;
  }
  ids = next;
  persist();
}

export function removeRecentThread(id: string): void {
  hydrate();
  const next = ids.filter((item) => item !== id);
  if (next.length === ids.length) return;
  ids = next;
  persist();
}

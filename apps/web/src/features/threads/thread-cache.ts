import type { Thread } from '@agent/agent-models';
import { listThreads } from '../api/thread-client';

type Listener = () => void;

let threads: Thread[] = [];
let loaded = false;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeThreads(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getThreadsSnapshot(): Thread[] {
  return threads;
}

export async function refreshThreads(): Promise<Thread[]> {
  threads = await listThreads();
  loaded = true;
  emit();
  return threads;
}

export function ensureThreadsLoaded(): void {
  if (loaded) return;
  void refreshThreads().catch((error) => {
    console.error('Failed to load threads', error);
  });
}

export function areThreadsLoaded(): boolean {
  return loaded;
}

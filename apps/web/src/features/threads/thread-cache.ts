import type { Thread } from '@agent/agent-models';
import {
  createThread as postThread,
  deleteThread,
  listThreads,
  patchThread,
} from '../../api/thread-client';
import { clearContextAnchor } from '../conversation/context-anchor';
import { removeRecentThread } from './recent-threads-store';
import { ensureWorkspaceInOrder } from './space-store';

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

/*
 * Thread changes go through here so each one does its bookkeeping (recent
 * list, context meter, workspace order) and refreshes the list once.
 */

export async function createThread(
  ...args: Parameters<typeof postThread>
): Promise<Thread> {
  const thread = await postThread(...args);
  if (thread.workspaceRoot) ensureWorkspaceInOrder(thread.workspaceRoot);
  await refreshThreads();
  return thread;
}

/** No request when the cached thread already has these values. */
export async function updateThread(
  id: string,
  changes: Parameters<typeof patchThread>[1],
): Promise<void> {
  const cached = threads.find((thread) => thread.id === id);
  const unchanged =
    cached &&
    Object.entries(changes).every(
      ([key, value]) => cached[key as keyof Thread] === value,
    );
  if (unchanged) return;
  await patchThread(id, changes);
  await refreshThreads();
}

export async function removeThread(id: string): Promise<void> {
  await deleteThread(id);
  removeRecentThread(id);
  clearContextAnchor(id);
  await refreshThreads();
}

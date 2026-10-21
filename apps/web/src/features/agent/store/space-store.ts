'use client';

import { useSyncExternalStore } from 'react';
import {
  normalizeWorkspaceRoot,
  sameWorkspaceRoot,
  workspaceRootKey,
} from '@agenticbot/agent-models';

export type SpaceState = {
  /** Composer binding for new chats. Null = Home (no folder). */
  workspaceRoot: string | null;
  /**
   * Recently opened workspace folders (absolute paths).
   * Used by the composer picker — not the sidebar group order.
   */
  recentFolders: string[];
  /**
   * Stable sidebar order for workspace projects (absolute paths).
   * Only folders with threads appear in the rail; drag updates this list.
   */
  workspaceOrder: string[];
  /** Folder paths the user collapsed in the sidebar. */
  collapsedFolders: string[];
};

const ROOT_KEY = 'agenticbot:workspaceRoot';
const FOLDERS_KEY = 'agenticbot:recentFolders';
const ORDER_KEY = 'agenticbot:workspaceOrder';
const COLLAPSED_KEY = 'agenticbot:collapsedFolders';

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function readJsonArray(key: string): string[] {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
  } catch {
    return [];
  }
}

function normalizeRoot(root: string): string {
  return normalizeWorkspaceRoot(root);
}

function folderKey(root: string): string {
  return workspaceRootKey(root);
}

/** MRU for the composer picker only — does not move sidebar project rows. */
function upsertFolderMru(list: string[], root: string): string[] {
  const key = folderKey(root);
  const next = list.filter((item) => folderKey(item) !== key);
  next.unshift(normalizeRoot(root));
  return next.slice(0, 20);
}

function readStored(): SpaceState {
  try {
    const workspaceRoot = localStorage.getItem(ROOT_KEY);
    const recentFolders = readJsonArray(FOLDERS_KEY);
    const collapsedFolders = readJsonArray(COLLAPSED_KEY);
    let workspaceOrder = readJsonArray(ORDER_KEY);
    // Migrate: first visit after this feature uses recentFolders as a seed order.
    if (workspaceOrder.length === 0 && recentFolders.length > 0) {
      workspaceOrder = [...recentFolders];
    }
    const root = workspaceRoot?.trim() ? workspaceRoot : null;
    return {
      workspaceRoot: root,
      // Keep picker MRU in sync with the active root without implying sidebar order.
      recentFolders: root ? upsertFolderMru(recentFolders, root) : recentFolders,
      workspaceOrder,
      collapsedFolders,
    };
  } catch {
    return {
      workspaceRoot: null,
      recentFolders: [],
      workspaceOrder: [],
      collapsedFolders: [],
    };
  }
}

const SERVER_SNAPSHOT: SpaceState = {
  workspaceRoot: null,
  recentFolders: [],
  workspaceOrder: [],
  collapsedFolders: [],
};

let state: SpaceState = SERVER_SNAPSHOT;
let hydrated = false;

function hydrate(): SpaceState {
  if (!hydrated && typeof window !== 'undefined') {
    state = readStored();
    hydrated = true;
  }
  return state;
}

function persistFolders(): void {
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(state.recentFolders));
    localStorage.setItem(ORDER_KEY, JSON.stringify(state.workspaceOrder));
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(state.collapsedFolders));
  } catch {
    /* private mode */
  }
}

export function getSpaceSnapshot(): SpaceState {
  return hydrate();
}

export function getServerSpaceSnapshot(): SpaceState {
  return SERVER_SNAPSHOT;
}

export function subscribeSpace(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Bind the composer to a folder. Updates picker MRU only.
 * Does not create a sidebar project row — that waits for the first thread
 * (see ensureWorkspaceInOrder / syncWorkspaceOrder).
 */
export function setWorkspaceRoot(workspaceRoot: string | null): void {
  hydrate();
  const next = workspaceRoot?.trim() ? normalizeRoot(workspaceRoot) : null;
  const sameRoot =
    (state.workspaceRoot === null && next === null) ||
    (state.workspaceRoot !== null &&
      next !== null &&
      folderKey(state.workspaceRoot) === folderKey(next));
  const recentFolders = next
    ? upsertFolderMru(state.recentFolders, next)
    : state.recentFolders;
  if (sameRoot && recentFolders === state.recentFolders) return;
  state = {
    ...state,
    workspaceRoot: next,
    recentFolders,
  };
  try {
    if (next) localStorage.setItem(ROOT_KEY, next);
    else localStorage.removeItem(ROOT_KEY);
    persistFolders();
  } catch {
    /* private mode */
  }
  emit();
}

/** Append a project to the sidebar order once it has (or will have) threads. */
export function ensureWorkspaceInOrder(workspaceRoot: string): void {
  hydrate();
  const normalized = normalizeRoot(workspaceRoot);
  const key = folderKey(normalized);
  if (state.workspaceOrder.some((item) => folderKey(item) === key)) return;
  state = {
    ...state,
    workspaceOrder: [...state.workspaceOrder, normalized],
  };
  persistFolders();
  emit();
}

/**
 * Keep sidebar order in sync with folders that actually have threads:
 * drop empties, append newly discovered roots at the end (stable — no jump to top).
 */
export function syncWorkspaceOrder(rootsWithThreads: string[]): void {
  hydrate();
  const seen = new Set<string>();
  const normalizedRoots: string[] = [];
  for (const root of rootsWithThreads) {
    const normalized = normalizeRoot(root);
    const key = folderKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    normalizedRoots.push(normalized);
  }
  const rootByKey = new Map(
    normalizedRoots.map((root) => [folderKey(root), root] as const),
  );

  const next: string[] = [];
  for (const item of state.workspaceOrder) {
    const key = folderKey(item);
    const live = rootByKey.get(key);
    if (!live) continue;
    next.push(live);
    rootByKey.delete(key);
  }
  for (const root of normalizedRoots) {
    if (rootByKey.has(folderKey(root))) next.push(root);
  }

  const unchanged =
    next.length === state.workspaceOrder.length &&
    next.every(
      (root, index) =>
        folderKey(root) === folderKey(state.workspaceOrder[index] ?? ''),
    );
  if (unchanged) return;

  state = { ...state, workspaceOrder: next };
  persistFolders();
  emit();
}

/** Persist a full drag-reorder of workspace project rows. */
export function reorderWorkspaces(orderedRoots: string[]): void {
  hydrate();
  const next = orderedRoots
    .map((root) => normalizeRoot(root))
    .filter((root, index, all) => {
      const key = folderKey(root);
      return all.findIndex((item) => folderKey(item) === key) === index;
    });
  state = { ...state, workspaceOrder: next };
  persistFolders();
  emit();
}

export function removeRecentFolder(workspaceRoot: string): void {
  hydrate();
  const key = folderKey(workspaceRoot);
  const recentFolders = state.recentFolders.filter(
    (item) => folderKey(item) !== key,
  );
  const workspaceOrder = state.workspaceOrder.filter(
    (item) => folderKey(item) !== key,
  );
  const collapsedFolders = state.collapsedFolders.filter(
    (item) => folderKey(item) !== key,
  );
  const workspaceRootNext =
    state.workspaceRoot && folderKey(state.workspaceRoot) === key
      ? null
      : state.workspaceRoot;
  state = {
    ...state,
    recentFolders,
    workspaceOrder,
    collapsedFolders,
    workspaceRoot: workspaceRootNext,
  };
  try {
    if (!workspaceRootNext) localStorage.removeItem(ROOT_KEY);
    persistFolders();
  } catch {
    /* private mode */
  }
  emit();
}

export function toggleFolderCollapsed(workspaceRoot: string): void {
  hydrate();
  const key = folderKey(workspaceRoot);
  const collapsed = state.collapsedFolders.some(
    (item) => folderKey(item) === key,
  );
  const collapsedFolders = collapsed
    ? state.collapsedFolders.filter((item) => folderKey(item) !== key)
    : [...state.collapsedFolders, normalizeRoot(workspaceRoot)];
  state = { ...state, collapsedFolders };
  persistFolders();
  emit();
}

export function isFolderCollapsed(workspaceRoot: string): boolean {
  const key = folderKey(workspaceRoot);
  return state.collapsedFolders.some((item) => folderKey(item) === key);
}

export function folderNameFromRoot(root: string | null): string {
  if (!root) return '';
  const trimmed = normalizeRoot(root);
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? trimmed;
}

export { sameWorkspaceRoot };

export function useAgentSpace(): SpaceState {
  return useSyncExternalStore(
    subscribeSpace,
    getSpaceSnapshot,
    getServerSpaceSnapshot,
  );
}

'use client';

import { useSyncExternalStore } from 'react';
import type { ThreadKind } from '@org/agent-models';

export type AgentSpace = ThreadKind;

export type SpaceState = {
  space: AgentSpace;
  workspaceRoot: string | null;
  /** Recently opened coding folders (absolute paths). */
  recentFolders: string[];
  /** Folder paths the user collapsed in the sidebar. */
  collapsedFolders: string[];
};

const SPACE_KEY = 'agenticbot:space';
const ROOT_KEY = 'agenticbot:workspaceRoot';
const FOLDERS_KEY = 'agenticbot:recentFolders';
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
  return root.replace(/[\\/]+$/, '');
}

function folderKey(root: string): string {
  return normalizeRoot(root).toLowerCase();
}

function upsertFolder(list: string[], root: string): string[] {
  const key = folderKey(root);
  const next = list.filter((item) => folderKey(item) !== key);
  next.unshift(normalizeRoot(root));
  return next.slice(0, 20);
}

function readStored(): SpaceState {
  try {
    const space = localStorage.getItem(SPACE_KEY);
    const workspaceRoot = localStorage.getItem(ROOT_KEY);
    const recentFolders = readJsonArray(FOLDERS_KEY);
    const collapsedFolders = readJsonArray(COLLAPSED_KEY);
    const root = workspaceRoot?.trim() ? workspaceRoot : null;
    return {
      space: space === 'coding' ? 'coding' : 'research',
      workspaceRoot: root,
      recentFolders: root ? upsertFolder(recentFolders, root) : recentFolders,
      collapsedFolders,
    };
  } catch {
    return {
      space: 'research',
      workspaceRoot: null,
      recentFolders: [],
      collapsedFolders: [],
    };
  }
}

const SERVER_SNAPSHOT: SpaceState = {
  space: 'research',
  workspaceRoot: null,
  recentFolders: [],
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

export function setAgentSpace(space: AgentSpace): void {
  hydrate();
  if (state.space === space) return;
  state = { ...state, space };
  try {
    localStorage.setItem(SPACE_KEY, space);
  } catch {
    /* private mode */
  }
  emit();
}

export function setWorkspaceRoot(workspaceRoot: string | null): void {
  hydrate();
  const next = workspaceRoot?.trim() ? normalizeRoot(workspaceRoot) : null;
  const sameRoot =
    (state.workspaceRoot === null && next === null) ||
    (state.workspaceRoot !== null &&
      next !== null &&
      folderKey(state.workspaceRoot) === folderKey(next));
  const recentFolders = next
    ? upsertFolder(state.recentFolders, next)
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

export function removeRecentFolder(workspaceRoot: string): void {
  hydrate();
  const key = folderKey(workspaceRoot);
  const recentFolders = state.recentFolders.filter(
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
  const collapsed = state.collapsedFolders.some((item) => folderKey(item) === key);
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

export function sameWorkspaceRoot(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  return folderKey(left) === folderKey(right);
}

export function useAgentSpace(): SpaceState {
  return useSyncExternalStore(
    subscribeSpace,
    getSpaceSnapshot,
    getServerSpaceSnapshot,
  );
}

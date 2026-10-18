'use client';

import { useSyncExternalStore } from 'react';
import type { ThreadKind } from '@org/agent-models';

export type AgentSpace = ThreadKind;

export type SpaceState = {
  space: AgentSpace;
  workspaceRoot: string | null;
};

const SPACE_KEY = 'agenticbot:space';
const ROOT_KEY = 'agenticbot:workspaceRoot';

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function readStored(): SpaceState {
  try {
    const space = localStorage.getItem(SPACE_KEY);
    const workspaceRoot = localStorage.getItem(ROOT_KEY);
    return {
      space: space === 'coding' ? 'coding' : 'research',
      workspaceRoot: workspaceRoot?.trim() ? workspaceRoot : null,
    };
  } catch {
    return { space: 'research', workspaceRoot: null };
  }
}

const SERVER_SNAPSHOT: SpaceState = {
  space: 'research',
  workspaceRoot: null,
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
  const next = workspaceRoot?.trim() ? workspaceRoot.trim() : null;
  if (state.workspaceRoot === next) return;
  state = { ...state, workspaceRoot: next };
  try {
    if (next) localStorage.setItem(ROOT_KEY, next);
    else localStorage.removeItem(ROOT_KEY);
  } catch {
    /* private mode */
  }
  emit();
}

export function folderNameFromRoot(root: string | null): string {
  if (!root) return '';
  const trimmed = root.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? trimmed;
}

export function sameWorkspaceRoot(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (!left || !right) return false;
  return (
    left.replace(/[\\/]+$/, '').toLowerCase() ===
    right.replace(/[\\/]+$/, '').toLowerCase()
  );
}

export function useAgentSpace(): SpaceState {
  return useSyncExternalStore(
    subscribeSpace,
    getSpaceSnapshot,
    getServerSpaceSnapshot,
  );
}

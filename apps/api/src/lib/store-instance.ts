import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { configureSkillRoots } from '@agent/agent-core';

import { resolveAgentHome } from './agent-home.js';
import { MemoryStore } from './memory-store.js';
import { openThreadStore, type ThreadStore } from './thread-store.js';

function home(): string {
  const resolved = resolveAgentHome({
    env: process.env,
    homedir: os.homedir(),
  });
  if (process.env.AGENT_HOME) return resolved;
  const legacy = path.join(os.homedir(), '.local', 'agent');
  if (!existsSync(resolved) && existsSync(legacy)) return legacy;
  return resolved;
}

let storePromise: Promise<ThreadStore> | undefined;
let memoryStore: MemoryStore | undefined;

export function getAgentHome(): string {
  const dir = home();
  configureSkillRoots(path.join(dir, 'skills'));
  return dir;
}

export function getThreadStore(): Promise<ThreadStore> {
  if (!storePromise) {
    storePromise = openThreadStore(getAgentHome());
  }
  return storePromise;
}

export function getMemoryStore(): MemoryStore {
  if (!memoryStore) {
    memoryStore = new MemoryStore(getAgentHome());
  }
  return memoryStore;
}

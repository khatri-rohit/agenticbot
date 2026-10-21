import os from 'node:os';

import { resolveDeskHome } from './desk-home.js';
import { MemoryStore } from './memory-store.js';
import { openThreadStore, type ThreadStore } from './thread-store.js';

function home(): string {
  return resolveDeskHome({
    env: process.env,
    homedir: os.homedir(),
  });
}

let storePromise: Promise<ThreadStore> | undefined;
let memoryStore: MemoryStore | undefined;

export function getThreadStore(): Promise<ThreadStore> {
  if (!storePromise) {
    storePromise = openThreadStore(home());
  }
  return storePromise;
}

export function getMemoryStore(): MemoryStore {
  if (!memoryStore) {
    memoryStore = new MemoryStore(home());
  }
  return memoryStore;
}
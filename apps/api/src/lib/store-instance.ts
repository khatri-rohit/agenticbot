import os from 'node:os';

import { resolveAgenticbotHome } from './agenticbot-home.js';
import { openThreadStore, type ThreadStore } from './thread-store.js';

let storePromise: Promise<ThreadStore> | undefined;

export function getThreadStore(): Promise<ThreadStore> {
  if (!storePromise) {
    const home = resolveAgenticbotHome({
      env: process.env,
      homedir: os.homedir(),
    });
    storePromise = openThreadStore(home);
  }
  return storePromise;
}
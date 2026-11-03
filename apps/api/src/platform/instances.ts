import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  configureSkillRoots,
  configureSubagentRoot,
  listTools,
  skillLintWarnings,
  subagentProfileWarnings,
} from '@agent/agent-core';

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
let agentsConfigured = false;
let memoryStore: MemoryStore | undefined;

export function getAgentHome(): string {
  const dir = home();
  configureSkillRoots(path.join(dir, 'skills'));
  if (!agentsConfigured) {
    agentsConfigured = true;
    // User sub-agents: $AGENT_HOME/agents/<name>.md. Bad files are skipped, not fatal.
    configureSubagentRoot(
      path.join(dir, 'agents'),
      listTools().map((tool) => tool.definition.function.name),
    );
    for (const warning of subagentProfileWarnings()) {
      console.warn(`[agents] skipped ${warning}`);
    }
    // Large skills without core rules keep only their first block once evicted.
    for (const warning of skillLintWarnings()) {
      console.warn(`[skills] ${warning}`);
    }
  }
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

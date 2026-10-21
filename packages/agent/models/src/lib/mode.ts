import type { ThreadKind } from './thread.js';
import { isWorkspaceKind } from './thread.js';

/**
 * A profile is a policy bundle: model, temperature, tools, and loop limits.
 * Home vs workspace is binding; thinking is reserved.
 */
export type ModeName = 'home' | 'workspace' | 'thinking';

export interface ModeConfig {
  name: ModeName;
  model: string;
  temperature: number;
  /** Profile-optional tools (e.g. web_search); gated by client webSearch flag. */
  allowedTools: string[];
  /** Always-on tools. Server includes these regardless of webSearch. */
  globalTools: string[];
  limits: {
    maxIterations: number;
    maxToolCalls: number;
    maxRepeatedToolCalls: number;
    toolTimeoutMs: number;
  };
}

export const HOME_MODE: ModeConfig = {
  name: 'home',
  model: 'glm-5.2:cloud',
  temperature: 0.65,
  allowedTools: ['web_search'],
  globalTools: [
    'web_fetch',
    'load_skill',
    'memory',
    'plan',
    'todo',
    'ask_user',
    'offer_choice',
  ],
  limits: {
    maxIterations: 40,
    maxToolCalls: 60,
    maxRepeatedToolCalls: 2,
    toolTimeoutMs: 45_000,
  },
};

/** Folder-bound coding profile. Web search is optional (composer flag). */
export const WORKSPACE_MODE: ModeConfig = {
  name: 'workspace',
  model: 'glm-5.3:cloud',
  temperature: 0.2,
  allowedTools: ['web_search'],
  globalTools: [
    'web_fetch',
    'glob',
    'grep',
    'read_file',
    'edit_file',
    'run_terminal',
    'load_skill',
    'memory',
    'plan',
    'todo',
    'ask_user',
    'offer_choice',
  ],
  limits: {
    maxIterations: 100,
    maxToolCalls: 200,
    maxRepeatedToolCalls: 4,
    toolTimeoutMs: 120_000,
  },
};

export function modeForKind(kind: ThreadKind | undefined): ModeConfig {
  return isWorkspaceKind(kind) ? WORKSPACE_MODE : HOME_MODE;
}

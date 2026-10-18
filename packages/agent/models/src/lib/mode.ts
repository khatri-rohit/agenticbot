import type { ThreadKind } from './thread.js';

/**
 * A mode is a policy bundle: model, temperature, system prompt, allowed tools,
 * and loop limits. Research and coding ship as separate spaces; thinking is reserved.
 */
export type ModeName = 'research' | 'coding' | 'thinking';

export interface ModeConfig {
  name: ModeName;
  model: string;
  temperature: number;
  /** Mode-optional tools (e.g. web_search); gated by client webSearch flag. */
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

export const RESEARCH_MODE: ModeConfig = {
  name: 'research',
  model: 'glm-5.2:cloud',
  // model: 'llama3.1:8b',
  temperature: 0.7,
  allowedTools: ['web_search'],
  globalTools: ['web_fetch', 'load_skill', 'memory'],
  limits: {
    maxIterations: 16,
    maxToolCalls: 24,
    maxRepeatedToolCalls: 2,
    toolTimeoutMs: 30_000,
  },
};

/** Project-bound coding space. No default web search. Builds may exceed 30s. */
export const CODING_MODE: ModeConfig = {
  name: 'coding',
  model: RESEARCH_MODE.model,
  temperature: 0.2,
  allowedTools: [],
  globalTools: [
    'glob',
    'grep',
    'read_file',
    'edit_file',
    'run_terminal',
    'load_skill',
    'memory',
  ],
  limits: {
    maxIterations: 50,
    maxToolCalls: 100,
    maxRepeatedToolCalls: 5,
    toolTimeoutMs: 100_000,
  },
};

export function modeForKind(kind: ThreadKind | undefined): ModeConfig {
  return kind === 'coding' ? CODING_MODE : RESEARCH_MODE;
}

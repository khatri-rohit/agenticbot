/**
 * A mode is a policy bundle: model, temperature, system prompt, allowed tools,
 * and loop limits. v1 ships only `research`. The shape is ready for
 * `coding` and `thinking` modes without structural changes.
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
    maxIterations: 8,
    maxToolCalls: 12,
    maxRepeatedToolCalls: 2,
    toolTimeoutMs: 30_000,
  },
};

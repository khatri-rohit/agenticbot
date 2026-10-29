import type { ModelRole } from '@agent/agent-models';

/**
 * A sub-agent profile is data: which model role, which tools (intersected
 * with the parent's at spawn), which limits, what context it starts with,
 * and its role prompt. Built-ins live in profiles.ts; users add more as
 * `$AGENT_HOME/agents/<name>.md`.
 */
export type SubagentContext =
  /** Brief only. */
  | 'none'
  /** Brief + the parent's original request + project rules; starts from `diff`. */
  | 'diff'
  /** A copy of the parent conversation plus one question (cache-friendly prefix). */
  | 'fork';

export type SubagentLimits = {
  maxIterations: number;
  maxToolCalls: number;
  maxWallMs: number;
  /** Upper bound; the runner also caps it at a share of the parent's remaining budget. */
  maxPromptTokens: number;
};

export type SubagentProfile = {
  name: string;
  description: string;
  modelRole: ModelRole;
  /** Wanted tools. The child gets these ∩ the parent's registry − always-stripped. */
  tools: string[];
  limits: SubagentLimits;
  context: SubagentContext;
  /** Include the workspace AGENTS.md in the child prompt. */
  rules: boolean;
  /** Child ends by calling `report` (structured result). */
  report: boolean;
  prompt: string;
  source: 'builtin' | 'user';
};

/** Never available to a child: no asking the user, no durable state, no nesting. */
export const CHILD_STRIPPED_TOOLS = [
  'delegate',
  'offer_choice',
  'memory',
  'plan',
  'todo',
  'edit_file',
  'run_terminal',
] as const;

/** Parallel children per parent run. Extra spawns wait for a slot. */
export const MAX_CONCURRENT_SUBAGENTS = 4;

/** Rendered digest cap (~1.5k tokens). The full report goes to a blob. */
export const DIGEST_MAX_CHARS = 6_000;

/** Share of the parent's remaining prompt budget one child may spend. */
export const CHILD_BUDGET_SHARE = 0.25;

export const UNTRUSTED_SUBAGENT_BEGIN = 'UNTRUSTED_SUBAGENT_BEGIN';
export const UNTRUSTED_SUBAGENT_END = 'UNTRUSTED_SUBAGENT_END';

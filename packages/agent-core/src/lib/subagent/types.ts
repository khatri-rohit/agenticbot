import {
  CHILD_BUDGET_SHARE as LIMIT_CHILD_BUDGET_SHARE,
  MAX_CONCURRENT_SUBAGENTS as LIMIT_MAX_CONCURRENT,
  REPORT_MAX_CHARS,
  type ModelRole,
  type SubagentThoroughness,
} from '@agent/agent-models';

import type { ProfileThinking } from '../system1/effort';

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
  /**
   * Thinking for the child, resolved against the child model's own values:
   * `off` (if the model offers it), `max` (its highest level), or `default`.
   */
  thinking: ProfileThinking;
  /** Wanted tools. The child gets these ∩ the parent's registry − always-stripped. */
  tools: string[];
  limits: SubagentLimits;
  /**
   * Effort used when the brief names none. Its call budget becomes the
   * child's limit (THOROUGHNESS_TOOL_CALLS); unset = the profile limits.
   */
  defaultThoroughness?: SubagentThoroughness;
  context: SubagentContext;
  /** Include the workspace AGENTS.md in the child prompt. */
  rules: boolean;
  /** Child ends by calling `report` (structured result). */
  report: boolean;
  /**
   * Skills preloaded into the child prompt (full body when small, else core
   * rules). Children never see the catalog or get load_skill.
   */
  skills: string[];
  /** Also preload the parent's `/` picks for this send (review does). */
  inheritPickedSkills: boolean;
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
export const MAX_CONCURRENT_SUBAGENTS = LIMIT_MAX_CONCURRENT;

/**
 * Digest cap: the same number the child's report is held to, so a report
 * that keeps its bound reaches the parent whole. The full body also goes
 * to a blob.
 */
export const DIGEST_MAX_CHARS = REPORT_MAX_CHARS;

/** Share of the parent's remaining prompt budget one child may spend. */
export const CHILD_BUDGET_SHARE = LIMIT_CHILD_BUDGET_SHARE;

export const UNTRUSTED_SUBAGENT_BEGIN = 'UNTRUSTED_SUBAGENT_BEGIN';
export const UNTRUSTED_SUBAGENT_END = 'UNTRUSTED_SUBAGENT_END';

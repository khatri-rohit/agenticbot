import type { ThreadKind } from './thread.js';
import { isWorkspaceKind } from './thread.js';

/**
 * A profile is a policy bundle: temperature, tools, and loop limits.
 * Home vs workspace is binding.
 * `model` is a harness/CLI default only — web chat model id is UI/thread-owned
 * (`body.model ?? thread.model ?? HOME_MODE.model`), not modeForKind().model.
 */
export type ModeName = 'home' | 'workspace';

export type ModeLimits = {
  /** Model round-trips. Omitted = uncapped. */
  maxIterations?: number;
  /** Successful ready-tool admits. Omitted = uncapped. */
  maxToolCalls?: number;
  maxRepeatedToolCalls: number;
  toolTimeoutMs: number;
  /** Prompt tokens across all model calls of the run, sub-agents included. */
  maxPromptTokens?: number;
  /** Wall clock for the whole run. */
  maxWallMs?: number;
};

export interface ModeConfig {
  name: ModeName;
  /** Default model id for CLI/harness; not applied by API chat resolution. */
  model: string;
  temperature: number;
  /** Profile-optional tools (e.g. web_search); gated by client webSearch flag. */
  allowedTools: string[];
  /** Always-on tools. Server includes these regardless of webSearch. */
  globalTools: string[];
  limits: ModeLimits;
}

export const HOME_MODE: ModeConfig = {
  name: 'home',
  model: 'glm-5.2:cloud',
  temperature: 0.65,
  allowedTools: ['web_search'],
  globalTools: [
    'web_fetch',
    'recall',
    'load_skill',
    'memory',
    'plan',
    'todo',
    'offer_choice',
  ],
  limits: {
    maxIterations: 40,
    maxToolCalls: 80,
    maxRepeatedToolCalls: 4,
    toolTimeoutMs: 45_000,
    maxPromptTokens: 400_000,
    maxWallMs: 15 * 60_000,
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
    'diff',
    'recall',
    'load_skill',
    'memory',
    'plan',
    'todo',
    'offer_choice',
    'delegate',
  ],
  limits: {
    maxIterations: 200,
    maxToolCalls: 450,
    maxRepeatedToolCalls: 8,
    toolTimeoutMs: 120_000,
    maxPromptTokens: 2_500_000,
    maxWallMs: 30 * 60_000,
  },
};

export function modeForKind(kind: ThreadKind | undefined): ModeConfig {
  return isWorkspaceKind(kind) ? WORKSPACE_MODE : HOME_MODE;
}

/**
 * Model per job. `main` is the user's pick for the parent run; sub-agent
 * profiles name a role, and the host maps it to a model id (env-configured,
 * defaulting to `main`).
 */
export type ModelRole = 'main' | 'fast' | 'strong';

export type ModelRoles = Record<ModelRole, string>;

export function resolveModelRoles(input: {
  main: string;
  fast?: string;
  strong?: string;
}): ModelRoles {
  const fast = input.fast?.trim();
  const strong = input.strong?.trim();
  return {
    main: input.main,
    fast: fast || input.main,
    strong: strong || input.main,
  };
}

/**
 * Loop execution limits. These bound the agent's autonomy per run.
 *
 * Defaults are the Home profile. Workspace runs override via ModeConfig.limits.
 */
export const DEFAULT_LIMITS = {
  maxIterations: 20,
  maxToolCalls: 32,
  maxRepeatedToolCalls: 2,
  toolTimeoutMs: 45_000,
};

export type AgentLimits = {
  maxIterations: number;
  maxToolCalls: number;
  maxRepeatedToolCalls: number;
  toolTimeoutMs: number;
};

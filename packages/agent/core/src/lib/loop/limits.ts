/**
 * Loop execution limits. These bound the agent's autonomy per run.
 *
 * Defaults are tuned for local 8B models doing research tasks.
 * Override per-run via RunConfig.limits.
 */
export const DEFAULT_LIMITS = {
  maxIterations: 8,
  maxToolCalls: 12,
  maxRepeatedToolCalls: 2,
  toolTimeoutMs: 30_000,
};

export type AgentLimits = {
  maxIterations: number;
  maxToolCalls: number;
  maxRepeatedToolCalls: number;
  toolTimeoutMs: number;
};
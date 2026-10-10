/**
 * Loop execution limits. These bound the agent's autonomy per run.
 *
 * Defaults are tuned for local 8B models doing research tasks.
 * Override per-run via RunConfig.limits.
 */
export const DEFAULT_LIMITS = {
  maxIterations: 12,
  maxToolCalls: 20,
  maxRepeatedToolCalls: 4,
  toolTimeoutMs: 30_000,
};

export type AgentLimits = {
  maxIterations: number;
  maxToolCalls: number;
  maxRepeatedToolCalls: number;
  toolTimeoutMs: number;
};

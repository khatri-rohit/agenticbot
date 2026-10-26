/**
 * Loop execution limits. These bound the agent's autonomy per run.
 *
 * Defaults are the Home profile. Workspace sets its own finite iteration/tool
 * caps via WORKSPACE_MODE; omitted caps stay uncapped only when the host
 * passes a partial limits object without those fields.
 */
export const DEFAULT_LIMITS = {
  maxIterations: 40,
  maxToolCalls: 80,
  maxRepeatedToolCalls: 2,
  toolTimeoutMs: 45_000,
} as const;

export type AgentLimits = {
  /** Model round-trips. Omitted = uncapped. */
  maxIterations?: number;
  /** Total tool invocations. Omitted = uncapped. */
  maxToolCalls?: number;
  maxRepeatedToolCalls: number;
  toolTimeoutMs: number;
};

/**
 * Merge host overrides. When the host passes a limits object, omitted
 * iteration/tool caps stay uncapped (do not fall back to Home defaults).
 * When the host passes nothing, Home defaults apply.
 */
export function resolveLimits(partial?: Partial<AgentLimits>): AgentLimits {
  if (!partial) {
    return { ...DEFAULT_LIMITS };
  }
  return {
    maxRepeatedToolCalls:
      partial.maxRepeatedToolCalls ?? DEFAULT_LIMITS.maxRepeatedToolCalls,
    toolTimeoutMs: partial.toolTimeoutMs ?? DEFAULT_LIMITS.toolTimeoutMs,
    ...(partial.maxIterations !== undefined
      ? { maxIterations: partial.maxIterations }
      : {}),
    ...(partial.maxToolCalls !== undefined
      ? { maxToolCalls: partial.maxToolCalls }
      : {}),
  };
}

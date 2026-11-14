import type { TraceEvent } from '@agent/agent-models';

type PolicyDecision = Extract<TraceEvent, { type: 'policy_decision' }>;

/**
 * Trace one harness decision with why it was taken and what it read, so a
 * trace reader (health metrics, the Review) can name the mechanism behind
 * every action without re-deriving it.
 */
export function tracePolicyDecision(
  s: { runId: string; iterations: number; trace: (event: TraceEvent) => void },
  kind: PolicyDecision['kind'],
  ids: string[],
  reason?: string,
  inputs?: PolicyDecision['inputs'],
): void {
  s.trace({
    type: 'policy_decision',
    runId: s.runId,
    iteration: s.iterations,
    kind,
    ids,
    ...(reason ? { reason } : {}),
    ...(inputs ? { inputs } : {}),
  });
}

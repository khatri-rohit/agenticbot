import type { SubagentThoroughness, UsageTotals } from '@agent/agent-models';

/**
 * Delegation decisions as pure functions of what the harness knows (phase 4
 * of the v2 plan). The runner applies them and traces each as a
 * `policy_decision`; phase 5 moves them into the one policy module as they
 * are.
 */

/**
 * Effort is earned, not chosen: a new brief gets at most `medium`; `thorough`
 * is granted when resuming a sub-agent (evidence that a first pass was not
 * enough). The model asking for more on a first pass is capped, not refused,
 * so the work still starts.
 */
export function earnedThoroughness(
  requested: SubagentThoroughness | undefined,
  profileDefault: SubagentThoroughness | undefined,
  resuming: boolean,
): { thoroughness: SubagentThoroughness | undefined; capped: boolean } {
  const wanted = requested ?? profileDefault;
  if (wanted === 'thorough' && !resuming) return { thoroughness: 'medium', capped: true };
  return { thoroughness: wanted, capped: false };
}

/** `./src\\a/` → `src/a`; empty entries dropped. */
export function normalizeScopePaths(paths: readonly string[] | undefined): string[] {
  return (paths ?? [])
    .map((entry) => entry.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter((entry) => entry.length > 0 && entry !== '.');
}

/**
 * The first path of `next` that overlaps a path of `running` (the same
 * path, or one inside the other), or null. Paths are workspace-relative,
 * normalized by normalizeScopePaths.
 */
export function overlappingPath(next: readonly string[], running: readonly string[]): string | null {
  for (const a of next) {
    for (const b of running) {
      if (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return a;
    }
  }
  return null;
}

/** What `total` adds over what was already charged (never negative). */
export function usageDelta(total: UsageTotals, charged: UsageTotals): UsageTotals {
  return {
    promptTokens: Math.max(0, total.promptTokens - charged.promptTokens),
    completionTokens: Math.max(0, total.completionTokens - charged.completionTokens),
    calls: Math.max(0, total.calls - charged.calls),
    estimatedCalls: Math.max(0, total.estimatedCalls - charged.estimatedCalls),
  };
}

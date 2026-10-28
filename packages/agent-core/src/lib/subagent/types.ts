import type { RunPosture } from '@agent/agent-models';
import type { SubagentSpec, SubagentResult } from '@agent/agent-models';

// Re-export so agent-core consumers import from one place.
export type { SubagentSpec, SubagentResult };

/**
 * A named specialist profile. The residency play: each profile binds a
 * tool-subset, skill pack, model, posture, and prompt section so the child's
 * context cache is all signal for that job. The model picks a profile by
 * name; the runtime assembles the registry and prompt.
 */
export type SubagentProfile = {
  name: string;
  description: string;
  /** Tool allow-list applied to ALL_TOOLS. `delegate` is always excluded. */
  tools: string[];
  /** Skill packs to load into the child's system prompt at spawn. */
  skills: string[];
  /** Model id for the child run. */
  model: string;
  /** Child posture. May only narrow the parent's, never escalate. */
  posture: RunPosture;
  /** Injected into the child's system prompt as the role/behavior section. */
  promptSection: string;
};

/** What the model asks for via the `delegate` tool. */
// SubagentSpec and SubagentResult are re-exported from @agent/agent-models above.

export const MAX_SUBAGENT_DEPTH = 2;

export const DIGEST_MAX_CHARS = 2048;

/**
 * Encode a machine-readable header line for the delegate tool result.
 * The ledger stores tool content verbatim, so this header is durable —
 * the UI parses it to rebuild sub-agent cards on reload / history open.
 */
export function encodeSubagentHeader(
  result: SubagentResult,
  subThreadId: string,
  profile: string,
): string {
  return [
    `subagent:profile=${profile}`,
    `subThreadId=${subThreadId}`,
    `subRunId=${result.subRunId}`,
    `status=${result.status}`,
    `iterations=${result.iterations}`,
    `toolCalls=${result.toolCalls}`,
  ].join(' ');
}

/** Parse the subagent header from a ledger tool row. Returns null if absent. */
export function parseSubagentHeader(
  content: string,
): {
  profile: string;
  subThreadId: string;
  subRunId: string;
  status: string;
  iterations: number;
  toolCalls: number;
} | null {
  const line = content.split('\n')[0];
  if (!line.startsWith('subagent:')) return null;
  const fields = new Map<string, string>();
  for (const part of line.slice('subagent:'.length).split(' ')) {
    const eq = part.indexOf('=');
    if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const profile = fields.get('profile');
  const subThreadId = fields.get('subThreadId');
  const subRunId = fields.get('subRunId');
  if (!profile || !subThreadId || !subRunId) return null;
  return {
    profile,
    subThreadId,
    subRunId,
    status: fields.get('status') ?? 'completed',
    iterations: Number(fields.get('iterations') ?? 0),
    toolCalls: Number(fields.get('toolCalls') ?? 0),
  };
}
import type { RunUsage } from './run.js';

export type SubagentThoroughness = 'quick' | 'medium' | 'thorough';

/**
 * What the parent asks for via the `delegate` tool. `objective` and `scope`
 * are required so every brief states what to find and where to stop.
 */
export type SubagentSpec = {
  profile: string;
  objective: string;
  scope: string;
  /** What the report should emphasize (e.g. "call sites and their arguments"). */
  outputFocus?: string;
  thoroughness?: SubagentThoroughness;
  /** Child thread id to continue (keeps its history) instead of starting fresh. */
  resume?: string;
};

export type SubagentStatus = 'completed' | 'incomplete' | 'error' | 'cancelled';

/** Structured child report (the `report` tool's arguments). */
export type SubagentReport = {
  status: 'done' | 'partial' | 'blocked';
  summary: string;
  findings?: { claim: string; evidence?: string }[];
  issues?: {
    location: string;
    problem: string;
    fix?: string;
    severity?: 'high' | 'medium' | 'low';
  }[];
  openQuestions?: string[];
};

/** Bounded digest returned to the parent loop as the tool result. */
export type SubagentResult = {
  subRunId: string;
  subThreadId: string;
  profile: string;
  status: SubagentStatus;
  /** Rendered for the parent model; capped by the runner. */
  digest: string;
  iterations: number;
  toolCalls: number;
  limitReason?: string;
  usage: RunUsage;
  /** Blob holding the full report / final text, readable with `recall`. */
  reportSha?: string;
};

export type SubagentHeader = {
  profile: string;
  subThreadId: string;
  subRunId: string;
  status: SubagentStatus;
  iterations: number;
  toolCalls: number;
  reportSha?: string;
};

const HEADER_PREFIX = 'subagent:';

/**
 * First line of a delegate tool result. The ledger stores tool content
 * verbatim, so this header is durable — the UI rebuilds sub-agent cards
 * from it on reload.
 */
export function encodeSubagentHeader(result: SubagentResult): string {
  return [
    `${HEADER_PREFIX}profile=${result.profile}`,
    `subThreadId=${result.subThreadId}`,
    `subRunId=${result.subRunId}`,
    `status=${result.status}`,
    `iterations=${result.iterations}`,
    `toolCalls=${result.toolCalls}`,
    ...(result.reportSha ? [`reportSha=${result.reportSha}`] : []),
  ].join(' ');
}

const STATUSES: SubagentStatus[] = ['completed', 'incomplete', 'error', 'cancelled'];

/** Parse the header from a delegate tool result. Returns null if absent. */
export function parseSubagentHeader(content: string): SubagentHeader | null {
  const line = content.split('\n')[0] ?? '';
  if (!line.startsWith(HEADER_PREFIX)) return null;
  const fields = new Map<string, string>();
  for (const part of line.slice(HEADER_PREFIX.length).split(' ')) {
    const eq = part.indexOf('=');
    if (eq > 0) fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const profile = fields.get('profile');
  const subThreadId = fields.get('subThreadId');
  const subRunId = fields.get('subRunId');
  if (!profile || !subThreadId || !subRunId) return null;
  const rawStatus = fields.get('status') as SubagentStatus | undefined;
  const reportSha = fields.get('reportSha');
  return {
    profile,
    subThreadId,
    subRunId,
    status: rawStatus && STATUSES.includes(rawStatus) ? rawStatus : 'completed',
    iterations: Number(fields.get('iterations') ?? 0),
    toolCalls: Number(fields.get('toolCalls') ?? 0),
    ...(reportSha ? { reportSha } : {}),
  };
}

/** Body of a delegate tool result (everything after the header line). */
export function subagentDigestBody(content: string): string {
  const newline = content.indexOf('\n');
  return newline < 0 ? '' : content.slice(newline + 1).trim();
}

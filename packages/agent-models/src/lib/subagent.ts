import type { RunUsage } from './run.js';
import type { TaskFinding } from './task-state.js';

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
  /**
   * Workspace files or folders this brief covers. A brief whose paths
   * overlap a running sub-agent's is refused (two children reading the same
   * files cost the run twice for one answer).
   */
  paths?: string[];
  /** Child thread id to continue (keeps its history) instead of starting fresh. */
  resume?: string;
};

export type SubagentStatus = 'completed' | 'incomplete' | 'error' | 'cancelled';

/** Structured child report (the `report` tool's arguments). */
export type SubagentReport = {
  status: 'done' | 'partial' | 'blocked';
  summary: string;
  /**
   * The harness fills these from the child's recorded findings (checked
   * against the workspace); findings the model also put in its `report` call
   * are merged in by claim.
   */
  findings?: { claim: string; evidence?: string; verification?: TaskFinding['verification'] }[];
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
  /**
   * What the work amounts to, from evidence rather than the run's end alone:
   * `partial` when the child hit a limit or stopped, reported partial, or
   * left open questions; `blocked` when it reported blocked; else `done`.
   */
  reportStatus?: SubagentReportStatus;
  /** The child's findings (recorded and checked, plus any only in its report). */
  findings?: TaskFinding[];
  /** The child's open questions: the gaps the parent still has to check. */
  openQuestions?: string[];
};

export type SubagentReportStatus = SubagentReport['status'];

export type SubagentHeader = {
  profile: string;
  subThreadId: string;
  subRunId: string;
  status: SubagentStatus;
  iterations: number;
  toolCalls: number;
  reportSha?: string;
  reportStatus?: SubagentReportStatus;
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
    ...(result.reportStatus ? [`report=${result.reportStatus}`] : []),
  ].join(' ');
}

const STATUSES: SubagentStatus[] = ['completed', 'incomplete', 'error', 'cancelled'];
const REPORT_STATUSES: SubagentReportStatus[] = ['done', 'partial', 'blocked'];

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
  const reportStatus = fields.get('report') as SubagentReportStatus | undefined;
  return {
    profile,
    subThreadId,
    subRunId,
    status: rawStatus && STATUSES.includes(rawStatus) ? rawStatus : 'completed',
    iterations: Number(fields.get('iterations') ?? 0),
    toolCalls: Number(fields.get('toolCalls') ?? 0),
    ...(reportSha ? { reportSha } : {}),
    ...(reportStatus && REPORT_STATUSES.includes(reportStatus) ? { reportStatus } : {}),
  };
}

/** Body of a delegate tool result (everything after the header line). */
export function subagentDigestBody(content: string): string {
  const newline = content.indexOf('\n');
  return newline < 0 ? '' : content.slice(newline + 1).trim();
}

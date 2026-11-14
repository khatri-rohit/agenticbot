import { CHARS_PER_TOKEN, type TaskFinding } from '@agent/agent-models';

/**
 * How a task record (findings) is shown in a prompt, within a token bound:
 * the harness card shows this run's record, the prompt prefix shows the
 * record earlier runs of the thread left (context/carried-record). One
 * rendering, so a finding reads the same wherever it appears.
 */

/** Room kept in the record budget for its header, the hidden-findings count line and the sha line. */
const RECORD_RESERVE_CHARS = 700;
const TOPIC_COUNTS_MAX_CHARS = 400;
const TOPIC_MAX_CHARS = 60;

function findingLine(finding: TaskFinding): string {
  const topic = finding.topic ? `[${finding.topic.slice(0, TOPIC_MAX_CHARS)}] ` : '';
  const mark = finding.verification === 'unverified' ? ' (unverified)' : '';
  return `- ${topic}${finding.claim} — ${finding.evidence}${mark}`;
}

/** The record section's size bound on the card, from the window-scaled budget. */
export function recordCardChars(recordCardTokens: number): number {
  return recordCardTokens * CHARS_PER_TOKEN;
}

/** Newest findings that fit `chars`, shown oldest first (at least one). */
function newestWithin(findings: TaskFinding[], chars: number): string[] {
  const shown: string[] = [];
  let used = 0;
  for (let i = findings.length - 1; i >= 0; i--) {
    const line = findingLine(findings[i]!);
    if (used + line.length + 1 > chars && shown.length > 0) break;
    shown.unshift(line);
    used += line.length + 1;
  }
  return shown;
}

/** The card's header for this run's own record. */
function recordHeader(count: number): string {
  return `Record (${count} finding(s); answer from these and cite their evidence):`;
}

/**
 * The whole task record as one text, when it does not fit the card's record
 * budget; null when the card shows all of it. The residency pass stores this
 * as a blob, so findings the card cannot show stay recallable (P4: a
 * finding is the one item that cannot be got back any other way).
 */
export function recordOverflowText(findings: TaskFinding[], recordCardTokens: number): string | null {
  if (findings.length === 0) return null;
  const all = findings.map(findingLine);
  const size = recordHeader(findings.length).length + all.reduce((sum, line) => sum + line.length + 1, 0);
  if (size <= recordCardChars(recordCardTokens)) return null;
  return [`Task record: ${findings.length} finding(s), oldest first.`, ...all].join('\n');
}

/**
 * The record lines the card shows, within `recordCardTokens`: all findings
 * when they fit; otherwise the newest that fit, a per-topic count of the
 * rest, and the sha of the full record (`blobSha`, stored by the residency
 * pass) so nothing recorded is out of reach.
 */
export function recordSection(
  findings: TaskFinding[],
  recordCardTokens: number,
  blobSha?: string,
  header: (count: number) => string = recordHeader,
): string[] {
  if (findings.length === 0) return [];
  const budget = recordCardChars(recordCardTokens);
  if (recordOverflowText(findings, recordCardTokens) === null) {
    return [header(findings.length), ...findings.map(findingLine)];
  }
  const shown = newestWithin(findings, Math.max(1, budget - RECORD_RESERVE_CHARS));
  const hidden = findings.slice(0, findings.length - shown.length);
  const counts = new Map<string, number>();
  for (const finding of hidden) {
    const topic = finding.topic ? finding.topic.slice(0, TOPIC_MAX_CHARS) : '(no topic)';
    counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  const parts = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([topic, n]) => `${topic} ${n}`);
  let byTopic = '';
  for (let i = 0; i < parts.length; i++) {
    const next = byTopic ? `${byTopic}, ${parts[i]}` : parts[i]!;
    if (next.length > TOPIC_COUNTS_MAX_CHARS) {
      byTopic = `${byTopic}, +${parts.length - i} more topic(s)`;
      break;
    }
    byTopic = next;
  }
  return [
    header(findings.length),
    `- (${hidden.length} older finding(s) not shown, by topic: ${byTopic})`,
    ...(blobSha ? [`- (full record: recall sha256:${blobSha})`] : []),
    ...shown,
  ];
}


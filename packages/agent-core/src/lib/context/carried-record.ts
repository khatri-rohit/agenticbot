import {
  FINDINGS_MAX,
  type LedgerEnvelope,
  type RunTaskRecord,
  type TaskFinding,
  type TaskStateSnapshot,
} from '@agent/agent-models';

import { recordOverflowText, recordSection } from '../state/record-view';

/**
 * The task record across turns (v2 phase 6). A run's findings are the one
 * part of its context that cannot be got back by reading again (P4), so they
 * outlive the run: the host stores each run's record, and every later run of
 * the thread sees the records of the runs still in its ledger in the stable
 * prompt prefix (after the conversation summary, before the tail). Research
 * is not redone on the next turn, and compacting the conversation never
 * loses a recorded fact. A rewind drops the cut runs' records with them.
 */

/** Open questions carried forward (newest kept); older ones are in the earlier answers. */
const CARRIED_QUESTIONS_MAX = 10;

/** What a finished run leaves for later runs; null when it recorded nothing. */
export function taskRecordFromRun(
  runId: string,
  task: TaskStateSnapshot | undefined,
  finishedAt: string = new Date().toISOString(),
): RunTaskRecord | null {
  if (!task) return null;
  const findings = task.evidence.findings;
  if (findings.length === 0 && task.childGaps.length === 0) return null;
  return { runId, finishedAt, findings, openQuestions: [...task.childGaps] };
}

/** Run ids that still have rows in the ledger (a rewind removes the others). */
export function ledgerRunIds(envelopes: LedgerEnvelope[]): Set<string> {
  const ids = new Set<string>();
  for (const envelope of envelopes) if (envelope.runId) ids.add(envelope.runId);
  return ids;
}

export type CarriedRecord = { findings: TaskFinding[]; openQuestions: string[] };

/**
 * The records of runs still in the ledger, merged oldest first: one finding
 * per claim (the newest run's version wins), at most FINDINGS_MAX; open
 * questions deduplicated, newest kept.
 */
export function mergeCarriedRecords(records: RunTaskRecord[], liveRunIds: Set<string>): CarriedRecord {
  const byClaim = new Map<string, TaskFinding>();
  const questions: string[] = [];
  for (const record of records) {
    if (!liveRunIds.has(record.runId)) continue;
    for (const finding of record.findings) {
      byClaim.delete(finding.claim);
      byClaim.set(finding.claim, finding);
    }
    for (const question of record.openQuestions) {
      const index = questions.indexOf(question);
      if (index >= 0) questions.splice(index, 1);
      questions.push(question);
    }
  }
  const findings = [...byClaim.values()].slice(-FINDINGS_MAX);
  return { findings, openQuestions: questions.slice(-CARRIED_QUESTIONS_MAX) };
}

function carriedHeader(count: number): string {
  return `${count} finding(s) recorded in earlier runs of this thread. Use them instead of searching again; files may have changed since, so re-read a cited range before editing on it:`;
}

/**
 * The full carried record as one text when the prompt section cannot show
 * all of it (the host stores it as a blob and passes its sha), else null.
 */
export function carriedRecordOverflow(record: CarriedRecord, tokens: number): string | null {
  return recordOverflowText(record.findings, tokens);
}

/**
 * The prompt section for the carried record, within `tokens`: every finding
 * when it fits, else the newest with a per-topic count of the rest and the
 * sha of the full record. Null when there is nothing to carry.
 */
export function renderCarriedRecord(record: CarriedRecord, tokens: number, blobSha?: string): string | null {
  if (record.findings.length === 0 && record.openQuestions.length === 0) return null;
  const lines = ['# Task record (earlier runs)'];
  lines.push(...recordSection(record.findings, tokens, blobSha, carriedHeader));
  if (record.openQuestions.length > 0) {
    lines.push('Left open by earlier runs:', ...record.openQuestions.map((question) => `- ${question}`));
  }
  return lines.join('\n');
}

/**
 * The carried-record section for the next run's prompt: merges the records of
 * runs still in the ledger, stores the full record as a blob when the
 * section cannot show all of it (so `recall` brings it back), and renders
 * the section within `tokens`. Null when there is nothing to carry.
 */
export async function prepareCarriedRecord(input: {
  records: RunTaskRecord[];
  envelopes: LedgerEnvelope[];
  tokens: number;
  putBlob?: (text: string) => Promise<string>;
}): Promise<string | null> {
  const merged = mergeCarriedRecords(input.records, ledgerRunIds(input.envelopes));
  const overflow = carriedRecordOverflow(merged, input.tokens);
  let sha: string | undefined;
  if (overflow && input.putBlob) {
    try {
      sha = await input.putBlob(overflow);
    } catch {
      // The section still shows the newest findings; only the full-record pointer is missing.
    }
  }
  return renderCarriedRecord(merged, input.tokens, sha);
}

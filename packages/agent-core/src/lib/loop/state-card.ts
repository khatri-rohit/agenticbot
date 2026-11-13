import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { CHARS_PER_TOKEN, type TaskFinding } from '@agent/agent-models';

import { residentReadPaths } from '../context/residency';
import { cardDue, cardItems, EVIDENCE_WORDS } from '../policy';
import { pathFromToolArgs } from './call-identity';
import { tracePolicyDecision } from './policy-trace';
import type { RunState } from './run-state';

/**
 * The harness card: one ephemeral message appended to each model call,
 * rebuilt from task state every time and never stored in the live messages
 * or the ledger. It replaces notes that used to be appended to tool results
 * and the prompt (serial reads, stall, budget, advisor hint): those
 * persisted, cost tokens on every later call, and changed the prompt. The
 * card sits after the cached prefix, so the prefix stays stable.
 *
 * It also carries the task record: the findings recorded with
 * record_finding. They are the run's durable research memory, so file reads
 * can leave the prompt without being read again, and the answer is written
 * from them.
 */

export const CARD_HEADER = '[Harness card: this run\'s state, rebuilt every step by the harness, not from the user]';

/*
 * Which items show and when the card goes out is policy/card (marks in
 * harness-limits CARD_MARKS); the numbers below only size what it prints.
 */
const WORKING_SET_MAX = 6;
/** Re-read paths the `open:reread` item names. */
const REREAD_PATHS_MAX = 3;
/** Newest sub-agent gaps the card names; the rest are counted. */
const CHILD_GAPS_SHOWN = 3;
/** Room kept in the record budget for its header, the hidden-findings count line and the sha line. */
const RECORD_RESERVE_CHARS = 700;
const TOPIC_COUNTS_MAX_CHARS = 400;
const TOPIC_MAX_CHARS = 60;

function tokensK(tokens: number): string {
  if (tokens < 1_000) return `${Math.round(tokens)}`;
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;
}

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
export function recordSection(findings: TaskFinding[], recordCardTokens: number, blobSha?: string): string[] {
  if (findings.length === 0) return [];
  const budget = recordCardChars(recordCardTokens);
  if (recordOverflowText(findings, recordCardTokens) === null) {
    return [recordHeader(findings.length), ...findings.map(findingLine)];
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
    recordHeader(findings.length),
    `- (${hidden.length} older finding(s) not shown, by topic: ${byTopic})`,
    ...(blobSha ? [`- (full record: recall sha256:${blobSha})`] : []),
    ...shown,
  ];
}

/** Text of the card for this call, or null when it has nothing to say. */
export function buildStateCard(s: RunState, perCallTokens: number): string | null {
  return composeStateCard(s, perCallTokens)?.text ?? null;
}

/**
 * The card plus the ids of the open items and advice it shows, so the trace
 * can tell when each piece of advice first appeared (phase-0 measure of
 * whether advice changes behaviour).
 */
export function composeStateCard(
  s: RunState,
  perCallTokens: number,
): { text: string; ids: string[] } | null {
  const ids: string[] = [];
  const task = s.task.snapshot();
  // The step this card goes out with (the tracker advances on its llm_request).
  const step = s.iterations;
  const changing = task.shape === 'change';
  // No evidence yet whether the task changes the workspace: advice stays neutral.
  const unknown = task.shape === 'unknown';
  const canRecord = s.tools.byName.has('record_finding');
  const findings = task.evidence.findings;

  // Working set as the prompt holds it right now, newest touch first: files
  // whose latest read is resident, plus files being changed. A file whose
  // read became a card is counted, never listed as if still visible.
  const resident = residentReadPaths(s.messages, pathFromToolArgs);
  const touched = task.workingSet
    .map((entry) => ({ entry, touch: s.task.lastTouch(entry.path) ?? 0 }))
    .sort((a, b) => b.touch - a.touch);
  const hot = touched.filter(({ entry }) => resident.has(entry.path) || s.task.isUnchecked(entry.path));
  const cold = touched.filter(
    ({ entry }) => entry.reads > 0 && !resident.has(entry.path) && !s.task.isUnchecked(entry.path),
  ).length;

  // Which items show is policy (policy/card); this file only words them.
  const stall = s.steering.stalled();
  const items = cardItems({
    shape: task.shape,
    posture: s.posture,
    taskClass: task.taskClass,
    canDelegate: s.tools.byName.has('delegate'),
    canRecord,
    edits: task.evidence.edits,
    unverifiedSince: task.evidence.unverifiedSince,
    lastCheck: task.evidence.lastCheck,
    reviewed: task.evidence.reviewed,
    rereadPaths: canRecord && !changing ? s.task.uncitedRestoredPaths() : [],
    childGaps: task.childGaps,
    serialReadTurns: s.serialReadTurns,
    ...(stall ? { stall } : {}),
    nearBudget: s.budget.nearLimit() !== undefined,
  });

  const open: string[] = [];
  const advice: string[] = [];
  for (const item of items) {
    ids.push(item.id);
    switch (item.id) {
      case 'open:unchecked':
        open.push(`Edits since step ${item.since} have no check yet (build, typecheck, test or lint).`);
        break;
      case 'open:check_failed':
        open.push(`Last check failed: \`${item.command}\` exited ${item.exitCode}.`);
        break;
      case 'open:review':
        open.push('Edits pass the check: run delegate(review) once, then report.');
        break;
      case 'open:reread': {
        const more = item.paths.length > REREAD_PATHS_MAX ? `, +${item.paths.length - REREAD_PATHS_MAX} more` : '';
        open.push(
          `Re-read after removal: ${item.paths.slice(0, REREAD_PATHS_MAX).join(', ')}${more}. Record the facts you need from them with record_finding so they need not be read again.`,
        );
        break;
      }
      case 'open:child_gaps': {
        const shown = item.gaps.slice(-CHILD_GAPS_SHOWN);
        const more = item.gaps.length > shown.length ? ` (+${item.gaps.length - shown.length} more)` : '';
        open.push(
          `Sub-agent gaps to check (their findings are in the record; do not re-verify those): ${shown.join('; ')}${more}`,
        );
        break;
      }
      case 'advice:serial_reads':
        advice.push(
          `${item.turns} turns in a row made one read call, and each turn re-sends ~${tokensK(perCallTokens)} tokens. Put independent reads and searches in one turn; they run in parallel.`,
        );
        break;
      case 'advice:stall': {
        const callsLeft = Math.floor(Math.max(0, item.max - s.budget.spent()) / Math.max(1, perCallTokens));
        const delegate = s.tools.byName.has('delegate')
          ? ' If one specific fact is missing, delegate(explore) with that question instead of searching more.'
          : '';
        const act = changing
          ? 'Act on what you have: make the change.'
          : unknown
            ? canRecord
              ? 'Act on what you have: make the change if one was asked; otherwise record what you confirmed with record_finding and answer from the record.'
              : 'Act on what you have: make the change if one was asked; otherwise answer from what you have confirmed.'
            : canRecord
              ? 'Record what you have confirmed with record_finding and answer from the record; say what was not found.'
              : 'Answer from what you have confirmed; say what was not found.';
        advice.push(
          `${tokensK(item.idle)} tokens (${Math.round((item.idle / item.max) * 100)}% of the run budget) since the last evidence (${EVIDENCE_WORDS}); about ${callsLeft} calls left at this size. ${act}${delegate}`,
        );
        break;
      }
      case 'advice:budget':
        advice.push(
          changing
            ? 'Run budget nearly spent: finish the current step, run the check once, and report what is done and what is left. Do not start new work.'
            : unknown
              ? 'Run budget nearly spent: finish the current step, verify any edits once, and report what is done and what is left. Do not start new work.'
              : 'Run budget nearly spent: stop searching. Answer now from what is recorded and say what is still open.',
        );
        break;
    }
  }
  // One-shot advice raised by an event the harness could not act on itself
  // (the advisor hint after a repeated identical outcome).
  const oneShot = s.advisories.splice(0);
  advice.push(...oneShot);
  if (oneShot.length > 0) ids.push('advice:one_shot');

  const hasNews = open.length > 0 || advice.length > 0 || findings.length > 0;
  if (!cardDue({ hasNews, step, workingSetSize: task.workingSet.length })) return null;

  const budget = s.limits.maxPromptTokens;
  let spend = '';
  if (budget !== undefined) {
    // Own calls and sub-agents apart: they are different levers (P7).
    const usage = s.budget.snapshot();
    const children = usage.children.promptTokens;
    spend = ` · run budget: ${tokensK(usage.own.promptTokens)} own${
      children > 0 ? ` + ${tokensK(children)} sub-agents` : ''
    } of ${tokensK(budget)} used`;
  }
  const lines = [
    CARD_HEADER,
    `Phase: ${task.phase} · step ${step} · task ${task.taskClass} ${task.shape} · ~${tokensK(perCallTokens)} tokens per call${spend}`,
  ];
  if (hot.length > 0 || cold > 0) {
    const files = hot.slice(0, WORKING_SET_MAX).map(({ entry }) => {
      const mark = s.task.isUnchecked(entry.path) ? ' (edited, unchecked)' : entry.edits > 0 ? ' (edited)' : '';
      return `${entry.path}${mark}`;
    });
    const more = hot.length > WORKING_SET_MAX ? `, +${hot.length - WORKING_SET_MAX} more` : '';
    const older =
      cold > 0
        ? `${files.length > 0 ? '; ' : ''}${cold} file(s) read earlier are no longer in full view (read_file again if needed)`
        : '';
    lines.push(`Working set: ${files.join(', ')}${more}${older}`);
  }
  lines.push(...recordSection(findings, s.contextBudget.recordCardTokens, s.recordBlobSha));
  if (open.length > 0) lines.push(...open.map((line) => `Open: ${line}`));
  if (advice.length > 0) lines.push('Advice:', ...advice.map((line) => `- ${line}`));
  return { text: lines.join('\n'), ids };
}

/** The messages one model call sends: the live prompt plus this step's card. */
export function withStateCard(
  s: RunState,
  messages: ChatCompletionMessageParam[],
  perCallTokens: number,
): ChatCompletionMessageParam[] {
  if (!s.flags.stateCard) return messages;
  const card = composeStateCard(s, perCallTokens);
  if (!card) return messages;
  if (card.ids.length > 0) {
    const task = s.task;
    tracePolicyDecision(s, 'card', card.ids, 'open items and advice shown on this call', {
      shape: task.shape,
      phase: task.current,
      stepsSinceEvidence: task.stepsSinceEvidence,
      findings: task.findingCount,
    });
  }
  return [...messages, { role: 'user', content: card.text }];
}

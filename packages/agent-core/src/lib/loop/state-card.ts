import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { RECORD_CARD_MAX_CHARS, type TaskFinding } from '@agent/agent-models';

import { residentReadPaths } from '../context/residency';
import { pathFromToolArgs } from './call-identity';
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

/** Turns in a row whose only call was one read-stage tool before batching advice. */
export const SERIAL_READ_ADVICE_AFTER = 4;
/** The card is skipped on the first steps of a run unless it has something to say. */
const QUIET_STEPS = 2;
const WORKING_SET_MAX = 6;
/** Files read that no finding cites before the card asks for findings. */
export const UNRECORDED_READS_OPEN_AT = 4;

function tokensK(tokens: number): string {
  if (tokens < 1_000) return `${Math.round(tokens)}`;
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;
}

function findingLine(finding: TaskFinding): string {
  const topic = finding.topic ? `[${finding.topic}] ` : '';
  return `- ${topic}${finding.claim} — ${finding.evidence}`;
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

  const open: string[] = [];
  if (task.evidence.unverifiedSince !== null) {
    open.push(
      `Edits since step ${task.evidence.unverifiedSince} have no check yet (build, typecheck, test or lint).`,
    );
    ids.push('open:unchecked');
  }
  const lastCheck = task.evidence.lastCheck;
  if (lastCheck && lastCheck.exitCode !== 0 && task.evidence.unverifiedSince === null) {
    open.push(`Last check failed: \`${lastCheck.command}\` exited ${lastCheck.exitCode}.`);
    ids.push('open:check_failed');
  }
  if (
    s.posture === 'agent' &&
    s.tools.byName.has('delegate') &&
    task.taskClass !== 'small' &&
    task.evidence.edits > 0 &&
    task.evidence.unverifiedSince === null &&
    lastCheck?.exitCode === 0 &&
    !task.evidence.reviewed
  ) {
    open.push('Edits pass the check: run delegate(review) once, then report.');
    ids.push('open:review');
  }
  if (!changing && canRecord) {
    // Reads no finding stands for must stay in the prompt or be read again.
    const unrecorded = task.workingSet.filter((entry) => entry.reads > 0 && !s.task.isCited(entry.path)).length;
    if (unrecorded >= UNRECORDED_READS_OPEN_AT) {
      open.push(
        `${unrecorded} file(s) read are not cited by any finding: record each confirmed fact with record_finding (claim + path:line), so those reads can leave the context without being read again.`,
      );
      ids.push('open:unrecorded');
    }
  }

  const advice: string[] = [];
  if (s.serialReadTurns >= SERIAL_READ_ADVICE_AFTER) {
    advice.push(
      `${s.serialReadTurns} turns in a row made one read call, and each turn re-sends ~${tokensK(perCallTokens)} tokens. Put independent reads and searches in one turn; they run in parallel.`,
    );
    ids.push('advice:serial_reads');
  }
  const stall = s.steering.stalled();
  if (stall) {
    const spent = s.budget.spent();
    const callsLeft = Math.floor(Math.max(0, stall.max - spent) / Math.max(1, perCallTokens));
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
      `${tokensK(stall.idle)} tokens (${Math.round((stall.idle / stall.max) * 100)}% of the run budget) since the last evidence (an edit, a passing check or a recorded finding); about ${callsLeft} calls left at this size. ${act}${delegate}`,
    );
    ids.push('advice:stall');
  }
  if (s.budget.nearLimit()) {
    advice.push(
      changing
        ? 'Run budget nearly spent: finish the current step, run the check once, and report what is done and what is left. Do not start new work.'
        : unknown
          ? 'Run budget nearly spent: finish the current step, verify any edits once, and report what is done and what is left. Do not start new work.'
          : 'Run budget nearly spent: stop searching. Answer now from what is recorded and say what is still open.',
    );
    ids.push('advice:budget');
  }
  const oneShot = s.advisories.splice(0);
  advice.push(...oneShot);
  if (oneShot.length > 0) ids.push('advice:one_shot');

  const hasNews = open.length > 0 || advice.length > 0 || findings.length > 0;
  if (!hasNews && (step <= QUIET_STEPS || task.workingSet.length === 0)) return null;

  const budget = s.limits.maxPromptTokens;
  const lines = [
    CARD_HEADER,
    `Phase: ${task.phase} · step ${step} · task ${task.taskClass} ${task.shape} · ~${tokensK(perCallTokens)} tokens per call${
      budget !== undefined ? ` · ${tokensK(s.budget.spent())} of ${tokensK(budget)} run budget used` : ''
    }`,
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
  if (findings.length > 0) {
    // Newest first within the size bound, shown oldest first.
    const shown: string[] = [];
    let chars = 0;
    for (let i = findings.length - 1; i >= 0; i--) {
      const line = findingLine(findings[i]!);
      if (chars + line.length > RECORD_CARD_MAX_CHARS && shown.length > 0) break;
      shown.unshift(line);
      chars += line.length + 1;
    }
    const hidden = findings.length - shown.length;
    lines.push(
      `Record (${findings.length} finding(s); answer from these and cite their evidence):`,
      ...(hidden > 0 ? [`- (${hidden} older finding(s) not shown; they are in your earlier record_finding calls)`] : []),
      ...shown,
    );
  }
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
    s.trace({ type: 'policy_decision', runId: s.runId, iteration: s.iterations, kind: 'card', ids: card.ids });
  }
  return [...messages, { role: 'user', content: card.text }];
}

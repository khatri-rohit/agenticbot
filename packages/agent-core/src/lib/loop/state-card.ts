import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';


import { residentReadPaths } from '../context/residency';
import { cardDue, cardItems, classPace, EVIDENCE_WORDS } from '../policy';
import { recordSection } from '../state/record-view';
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
function tokensK(tokens: number): string {
  if (tokens < 1_000) return `${Math.round(tokens)}`;
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M` : `${Math.round(tokens / 1000)}k`;
}

export { recordCardChars, recordOverflowText, recordSection } from '../state/record-view';

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
          `${tokensK(item.idle)} tokens since the last evidence (${EVIDENCE_WORDS}): ${Math.round((item.idle / item.pace) * 100)}% of the ${tokensK(item.pace)} a ${item.taskClass} task is paced for; about ${callsLeft} calls left before the run cap at this size. ${act}${delegate}`,
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
    // The pace is what a task of this class is expected to cost; the cap is
    // the hard stop (policy/progress classPace).
    const pace = classPace(task.taskClass, budget);
    spend = ` · run budget: ${tokensK(usage.own.promptTokens)} own${
      children > 0 ? ` + ${tokensK(children)} sub-agents` : ''
    } of ${tokensK(budget)} used${pace < budget ? ` (${task.taskClass}-task pace ${tokensK(pace)})` : ''}`;
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

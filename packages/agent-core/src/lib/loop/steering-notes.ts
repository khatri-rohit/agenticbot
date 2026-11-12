import { estimatePromptTokens } from '../model/estimate-prompt-tokens';
import { pushHarnessNote, type RunState } from './run-state';

/**
 * Loop-control notes. None of them is a durable turn: they never reach the
 * ledger. With the harness card on (flags.stateCard), budget, stall and
 * advisor advice live on the card, rebuilt from state every step; these
 * functions then only trace the moment the condition starts. With it off
 * they append notes to the live prompt (the earlier behaviour, for A/B).
 */

export const OPEN_PLAN_WORK_NUDGE =
  'Open todos remain on the Final plan. Update todo status or finish those items before ending the turn. Do not claim the work is done.';

const BUDGET_NUDGE =
  'Run budget nearly spent. Finish the current step, run verification once, and report what is done and what is left. Do not start new work.';

const ADVISOR_HINT =
  'The same command produced the same result twice. If you are stuck, delegate to the advisor profile with the specific question instead of retrying.';

export function maybeWarnBudget(s: RunState): void {
  const warning = s.budget.takeWarning();
  if (!warning) return;
  if (!s.flags.stateCard) pushHarnessNote(s, BUDGET_NUDGE);
  s.trace({
    type: 'budget_warning',
    runId: s.runId,
    iteration: s.iterations,
    reason: 'prompt tokens',
    promptTokens: warning.spent,
    limitPromptTokens: warning.limit,
  });
}

export function maybeSteerProgress(s: RunState): void {
  const stall = s.steering.takeStallNudge();
  if (!stall) return;
  const { idle, max } = stall;
  const spent = s.budget.spent();
  if (!s.flags.stateCard) {
    const perCall = Math.max(1, estimatePromptTokens(s.messages, s.tools.definitions));
    const callsLeft = Math.floor(Math.max(0, max - spent) / perCall);
    const delegate = s.tools.byName.has('delegate')
      ? ' If one specific fact is still missing, delegate(explore) with that question instead of searching more yourself.'
      : '';
    pushHarnessNote(
      s,
      `${Math.round(idle / 1000)}k prompt tokens (${Math.round((idle / max) * 100)}% of this run's budget) went to steps with no edit. About ${callsLeft} model calls remain at the current context size. Act on what you have: make the change, or answer if no change was asked.${delegate}`,
    );
  }
  s.trace({
    type: 'stall_nudge',
    runId: s.runId,
    iteration: s.iterations,
    idleTokens: idle,
    promptTokens: spent,
    limitPromptTokens: max,
  });
}

export function maybeSuggestAdvisor(s: RunState): void {
  if (s.advisorHinted || !s.tools.byName.has('delegate')) return;
  s.advisorHinted = true;
  if (s.flags.stateCard) s.advisories.push(ADVISOR_HINT);
  else pushHarnessNote(s, ADVISOR_HINT);
}

import { CARD_MARKS } from '@agent/agent-models';

import { stubLiveToolResults } from '../context/assemble-context';
import {
  compactCurrentRun,
  foldResidue,
  manageWorkingSet,
  retireSkillBodies,
  type EvictionReason,
  type InRunCompactionResult,
} from '../context/residency';
import { estimatePromptTokens } from '../model/estimate-prompt-tokens';
import { sha256Text } from '../tools/web/source';
import { pathFromToolArgs } from './call-identity';
import { tracePolicyDecision } from './policy-trace';
import { recordDeltaTokens, recordMessage, removeRecordMessages } from './record-message';
import type { RunState } from './run-state';
import { recordOverflowText } from './state-card';

/**
 * The prompt projection after a tool turn (v2 phase 7). Between boundaries
 * the prompt only grows (new steps are appended); at a boundary it is
 * reshaped once, by every mechanism together, so the cached prefix breaks
 * at one known step instead of at each mechanism's own moment (P3).
 *
 * A boundary is any of: a verified milestone (a check passed after edits),
 * the working set over its cap or with enough stale results to clear, the
 * residue past its mark, a skill body retiring, the overflow guard, or the
 * card's new findings past `CARD_MARKS.recordDeltaTokens`. Once one fires,
 * the cheap removals ride along (stale results and card-only steps go at
 * any size: the prefix is broken anyway), and the run's task record is
 * written into the history as one message, cached until the next boundary.
 *
 * Order: cap oversized recent results and retire skill bodies; milestone
 * fold (before anything trims what it would fold); working set; residue
 * fold; overflow guard; then, at a boundary, the ride-along round and the
 * record message.
 */
export async function manageResidency(s: RunState): Promise<void> {
  const triggers: string[] = [];
  if (stubLiveToolResults(s.messages, s.contextBudget, s.runStart, s.flags) > 0) triggers.push('stub');

  for (const retired of retireSkillBodies(
    s.messages,
    s.skillLoads,
    s.iterations,
    s.contextBudget.skillResidentIterations,
  )) {
    // A reload after retirement is legitimate, not a repeat.
    s.guard.forgetSkillLoads();
    s.trace({
      type: 'skill_evicted',
      runId: s.runId,
      iteration: s.iterations,
      name: retired.name,
      residentIterations: s.contextBudget.skillResidentIterations,
    });
    if (!triggers.includes('skill')) triggers.push('skill');
  }

  const putBlob = (text: string) => s.webSources.putBlob(text);

  await storeRecordOverflow(s, putBlob);
  // Recap lines carry the step each folded call ran in.
  const stepOf = (toolCallId: string) => s.task.callIteration(toolCallId);

  const milestone = atVerifiedMilestone(s);
  if (milestone) {
    const compacted = await compactCurrentRun(
      s.messages,
      s.runStart,
      s.contextBudget,
      s.tools.definitions,
      putBlob,
      { milestone: true, stepOf, session: s.task.taskClass === 'long' },
    );
    if (compacted) {
      traceFold(s, compacted, 'milestone');
      triggers.push(compacted.session ? 'session' : 'milestone');
    }
  }

  if (await workingSetPass(s, s.contextBudget, putBlob)) triggers.push('working_set');

  // Without the card, the record_finding calls' arguments are the only copy
  // of the findings: steps holding them do not fold.
  const folded = await foldResidue(s.messages, s.runStart, s.contextBudget, s.tools.definitions, {
    keepFindingCalls: !s.flags.stateCard,
    stepOf,
    putBlob,
  });
  if (folded) {
    traceFold(s, folded, 'residue');
    triggers.push('residue');
  }

  if (!milestone && !s.prefixHeavy) {
    const compacted = await compactCurrentRun(
      s.messages,
      s.runStart,
      s.contextBudget,
      s.tools.definitions,
      putBlob,
      { stepOf },
    );
    if (compacted) {
      traceFold(s, compacted, undefined);
      triggers.push('overflow');
      if (compacted.prefixHeavy) {
        // Prior turns alone keep the prompt over the low mark. Folding one
        // more iteration per call would rewrite the prefix every call, so stop;
        // pre-run compaction handles this at the next run.
        s.prefixHeavy = true;
        s.trace({
          type: 'context_prefix_heavy',
          runId: s.runId,
          iteration: s.iterations,
          promptTokens: compacted.afterTokens,
        });
      }
    }
  }

  const findings = s.flags.stateCard ? s.task.snapshot().evidence.findings : [];
  const recordDue =
    findings.length > s.recordedThrough &&
    recordDeltaTokens(findings, s.recordedThrough) >= CARD_MARKS.recordDeltaTokens;
  if (triggers.length === 0 && !recordDue) return;
  if (triggers.length === 0) triggers.push('record');

  // Ride-along round: the prefix changes at this step anyway, so removals
  // that alone were not worth a cache break go now (a record-only boundary
  // keeps the break small: only from the old record message onward).
  if (!(triggers.length === 1 && triggers[0] === 'record')) {
    const rideAlong = { ...s.contextBudget, inRunClearAtLeastTokens: 0, inRunResidueFoldTokens: 0 };
    if (await workingSetPass(s, rideAlong, putBlob)) triggers.push('ride_along');
    const residue = await foldResidue(s.messages, s.runStart, rideAlong, s.tools.definitions, {
      keepFindingCalls: !s.flags.stateCard,
      stepOf,
      putBlob,
      requireSaving: true,
    });
    if (residue) {
      traceFold(s, residue, 'residue');
      if (!triggers.includes('ride_along')) triggers.push('ride_along');
    }
  }

  // The task record joins the history at the boundary (F-6); the card then
  // carries only findings recorded after it.
  if (s.flags.stateCard) {
    removeRecordMessages(s.messages, s.runStart);
    if (findings.length > 0) {
      s.messages.push(recordMessage(findings, s.contextBudget.recordCardTokens, s.recordBlobSha));
      s.recordedThrough = findings.length;
    }
  }
  tracePolicyDecision(s, 'boundary', triggers.map((trigger) => `boundary:${trigger}`), 'prompt reshaped once for all mechanisms', {
    findingsInHistory: s.recordedThrough,
  });
}

/** One working-set pass under `budget`; true when it removed anything. */
async function workingSetPass(
  s: RunState,
  budget: RunState['contextBudget'],
  putBlob: (text: string) => Promise<string>,
): Promise<boolean> {
  const evicted = await manageWorkingSet(
    s.messages,
    s.runStart,
    budget,
    s.tools.definitions,
    putBlob,
    pathFromToolArgs,
    {
      iteration: s.iterations,
      callIteration: (id) => s.task.callIteration(id),
      lastTouch: (path) => s.task.lastTouch(path),
      isUnchecked: (path) => s.task.isUnchecked(path),
      isCited: (path) => s.task.isCited(path),
    },
  );
  if (!evicted) return false;
  s.readDedupe.forget(evicted.toolCallIds);
  // One trace line per reason, so eval can tell stale copies, cold files,
  // cited files and budget pressure apart. Token counts are for the whole pass.
  for (const [reason, ids] of Object.entries(evicted.byReason) as Array<[EvictionReason, string[]]>) {
    s.trace({
      type: 'context_evicted',
      runId: s.runId,
      iteration: s.iterations,
      evicted: ids.length,
      beforeTokens: evicted.beforeTokens,
      afterTokens: evicted.afterTokens,
      toolCallIds: ids,
      reason,
    });
  }
  return true;
}

/**
 * Keep the whole task record recallable once it outgrows the card's record
 * budget: store it as a blob (again only when it changed) and keep the sha
 * on the run state for the card. Findings are never dropped from task
 * state; this makes the ones the card cannot show reachable at 0 calls'
 * search cost (one recall).
 */
async function storeRecordOverflow(s: RunState, putBlob: (text: string) => Promise<string>): Promise<void> {
  if (!s.flags.stateCard) return;
  const full = recordOverflowText(s.task.snapshot().evidence.findings, s.contextBudget.recordCardTokens);
  if (full === null) return;
  const key = sha256Text(full);
  if (key === s.recordBlobKey) return;
  s.recordBlobSha = await putBlob(full);
  s.recordBlobKey = key;
}

/** Forget what a fold removed and trace it. `reason` undefined = the size mark. */
function traceFold(s: RunState, fold: InRunCompactionResult, reason: 'milestone' | 'residue' | undefined): void {
  s.readDedupe.forget(fold.toolCallIds);
  for (const id of fold.toolCallIds) s.skillLoads.delete(id);
  s.trace({
    type: 'context_compacted_inrun',
    runId: s.runId,
    iteration: s.iterations,
    beforeTokens: fold.beforeTokens,
    afterTokens: fold.afterTokens,
    toolCallIds: fold.toolCallIds,
    ...(reason ? { reason } : {}),
  });
}

/**
 * A check passed this iteration after edits (verified state), and this
 * run's own context is big enough that folding it pays for the one-time
 * change to the cached prefix.
 */
function atVerifiedMilestone(s: RunState): boolean {
  const check = s.task.snapshot().evidence.lastCheck;
  if (!check || check.iteration !== s.iterations || check.exitCode !== 0 || !check.afterEdit) {
    return false;
  }
  const ownTokens = estimatePromptTokens(s.messages.slice(s.runStart));
  return ownTokens >= 2 * s.contextBudget.inRunClearAtLeastTokens;
}

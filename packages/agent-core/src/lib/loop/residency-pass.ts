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
import type { RunState } from './run-state';
import { recordOverflowText } from './state-card';

/**
 * Prompt-only residency after a tool turn, in this order:
 * 1. cap oversized recent results and retire applied skill bodies;
 * 2. at a verified milestone (a check passed after edits), fold the run's
 *    earlier steps into the recap: one change to the cached prompt at a
 *    known point, before anything else trims what it would fold;
 * 3. keep tool results to the working set (task state decides what is in
 *    use; findings stand for the files they cite; past the cap, down to the
 *    low mark in one pass);
 * 4. fold old steps that hold only cards once their residue passes its mark;
 * 5. otherwise fold old iterations when the prompt passes the size mark.
 */
export async function manageResidency(s: RunState): Promise<void> {
  stubLiveToolResults(s.messages, s.contextBudget, s.runStart, s.flags);

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
      { milestone: true, stepOf },
    );
    if (compacted) traceFold(s, compacted, 'milestone');
  }

  const evicted = await manageWorkingSet(
    s.messages,
    s.runStart,
    s.contextBudget,
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
  if (evicted) {
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
  }

  // Without the card, the record_finding calls' arguments are the only copy
  // of the findings: steps holding them do not fold.
  const folded = await foldResidue(s.messages, s.runStart, s.contextBudget, s.tools.definitions, {
    keepFindingCalls: !s.flags.stateCard,
    stepOf,
  });
  if (folded) traceFold(s, folded, 'residue');

  if (milestone || s.prefixHeavy) return;
  const compacted = await compactCurrentRun(
    s.messages,
    s.runStart,
    s.contextBudget,
    s.tools.definitions,
    putBlob,
    { stepOf },
  );
  if (!compacted) return;
  traceFold(s, compacted, undefined);
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

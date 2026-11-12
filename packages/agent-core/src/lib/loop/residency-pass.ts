import { stubLiveToolResults } from '../context/assemble-context';
import {
  compactCurrentRun,
  manageWorkingSet,
  retireSkillBodies,
  type EvictionReason,
} from '../context/residency';
import { estimatePromptTokens } from '../model/estimate-prompt-tokens';
import { pathFromToolArgs } from './call-identity';
import type { RunState } from './run-state';

/**
 * Prompt-only residency after a tool turn: cap oversized recent results,
 * keep tool results to the working set (task state decides what is in use),
 * then fold old iterations of this run — at a verified milestone, or when
 * the prompt passes the size mark.
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
    },
  );
  if (evicted) {
    s.readDedupe.forget(evicted.toolCallIds);
    // One trace line per reason, so eval can tell stale copies, cold files
    // and budget pressure apart. Token counts are for the whole pass.
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

  const milestone = atVerifiedMilestone(s);
  if (s.prefixHeavy && !milestone) return;
  const compacted = await compactCurrentRun(
    s.messages,
    s.runStart,
    s.contextBudget,
    s.tools.definitions,
    putBlob,
    { milestone },
  );
  if (!compacted) return;
  s.readDedupe.forget(compacted.toolCallIds);
  for (const id of compacted.toolCallIds) s.skillLoads.delete(id);
  s.trace({
    type: 'context_compacted_inrun',
    runId: s.runId,
    iteration: s.iterations,
    beforeTokens: compacted.beforeTokens,
    afterTokens: compacted.afterTokens,
    toolCallIds: compacted.toolCallIds,
    ...(milestone ? { reason: 'milestone' as const } : {}),
  });
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

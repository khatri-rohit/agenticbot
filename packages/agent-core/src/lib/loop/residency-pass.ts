import { stubLiveToolResults } from '../context/assemble-context';
import {
  compactCurrentRun,
  evictToolResults,
  retireSkillBodies,
  supersedeToolResults,
} from '../context/residency';
import { pathFromToolArgs } from './call-identity';
import type { RunState } from './run-state';

/**
 * Prompt-only residency after a tool turn: cap oversized recent results,
 * evict old results to cards, then collapse old iterations of this run.
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

  // Redundant results first (stale versions of a read or command), so the
  // size-based pass below measures what is actually left.
  const superseded = await supersedeToolResults(
    s.messages,
    s.contextBudget,
    s.tools.definitions,
    putBlob,
    pathFromToolArgs,
  );
  if (superseded) {
    s.readDedupe.forget(superseded.toolCallIds);
    s.trace({
      type: 'context_evicted',
      runId: s.runId,
      iteration: s.iterations,
      evicted: superseded.evicted,
      beforeTokens: superseded.beforeTokens,
      afterTokens: superseded.afterTokens,
      toolCallIds: superseded.toolCallIds,
      reason: 'superseded',
    });
  }

  const evicted = await evictToolResults(
    s.messages,
    s.contextBudget,
    s.tools.definitions,
    putBlob,
  );
  if (evicted) {
    s.readDedupe.forget(evicted.toolCallIds);
    s.trace({
      type: 'context_evicted',
      runId: s.runId,
      iteration: s.iterations,
      evicted: evicted.evicted,
      beforeTokens: evicted.beforeTokens,
      afterTokens: evicted.afterTokens,
      toolCallIds: evicted.toolCallIds,
    });
  }

  if (s.prefixHeavy) return;
  const compacted = await compactCurrentRun(
    s.messages,
    s.runStart,
    s.contextBudget,
    s.tools.definitions,
    putBlob,
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

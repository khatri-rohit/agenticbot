import { stubLiveToolResults } from '../context/assemble-context';
import {
  compactCurrentRun,
  evictToolResults,
  retireSkillBodies,
} from '../context/residency';
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

  const evicted = await evictToolResults(
    s.messages,
    s.contextBudget,
    s.tools.definitions,
    (text) => s.webSources.putBlob(text),
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
  const compacted = compactCurrentRun(
    s.messages,
    s.runStart,
    s.contextBudget,
    s.tools.definitions,
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

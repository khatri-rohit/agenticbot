import type {
  ContextReport,
  LedgerEnvelope,
  Snapshot,
} from '@agent/agent-models';
import {
  buildExtractiveSnapshot,
  planCompaction,
  traceCompactionEvent,
} from '@agent/agent-core';

import { runManager } from '../platform/instances';
import { threadTraceSink } from '../platform/trace-sink.js';
import type { ThreadStore } from '../threads/thread-store';

/**
 * Write the snapshot core's compaction decision asks for (see planCompaction).
 * Returns it, or null when nothing was compacted. Runs after every run that
 * was not cancelled and, for an oversized start, before one.
 */
export async function compactThread(input: {
  store: ThreadStore;
  threadId: string;
  model: string;
  envelopes: LedgerEnvelope[];
  report: ContextReport;
}): Promise<Snapshot | null> {
  const { store, envelopes } = input;
  const throughSeq = planCompaction(envelopes, input.report);
  if (throughSeq == null) return null;
  const existing = await store.readSnapshot(input.threadId);
  if (existing && existing.throughSeq >= throughSeq) return null;

  const snapshot = buildExtractiveSnapshot({
    threadId: input.threadId,
    model: input.model,
    envelopes,
    throughSeq,
  });
  await store.writeSnapshot(input.threadId, snapshot);
  return snapshot;
}

/** UI notice + trace for a snapshot written during `runId`. */
export function emitCompacted(
  store: ThreadStore,
  runId: string,
  threadId: string,
  snapshot: Snapshot,
): void {
  runManager.publish(runId, {
    type: 'context.compacted',
    runId,
    threadId,
    throughSeq: snapshot.throughSeq,
    brief: snapshot.brief,
    summary: snapshot.summary,
    createdAt: snapshot.createdAt,
  });
  threadTraceSink(
    store,
    threadId,
  )(traceCompactionEvent({ runId, threadId, snapshot }));
}

/**
 * After a run: compact when the run's own closing report (the context after
 * its final answer) is over the threshold. No re-assembly: the next run's
 * pre-run pass catches anything this estimate misses.
 */
export async function maybeCompactThread(input: {
  store: ThreadStore;
  threadId: string;
  runId: string;
  model: string;
  report: ContextReport;
}): Promise<void> {
  if (!input.report.needsCompaction) return;
  const { store, threadId, runId } = input;
  runManager.publish(runId, { type: 'context.compacting', runId, threadId });
  const snapshot = await compactThread({
    store,
    threadId,
    model: input.model,
    envelopes: await store.hydrateEnvelopes(threadId),
    report: input.report,
  });
  if (snapshot) emitCompacted(store, runId, threadId, snapshot);
}

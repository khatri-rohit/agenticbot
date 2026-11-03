import type {
  ContextReport,
  LedgerEnvelope,
  OllamaEndpoint,
  Snapshot,
} from '@agent/agent-models';
import {
  buildExtractiveSnapshot,
  chooseCompactThroughSeqForTarget,
  traceCompactionEvent,
} from '@agent/agent-core';

import { getThreadStore, runManager } from '../platform/instances';
import { threadTraceSink } from '../platform/trace-sink.js';
import type { ThreadStore } from '../threads/thread-store';
import {
  lastUserEnvelope,
  prepareRun,
  resolveRequestedSkills,
} from './run-context';

/**
 * Extractive compaction (no LLM): when `report` says the thread is over
 * compactAtRatio, cut older turns until history fits compactToRatio and write
 * the snapshot. Returns the snapshot, or null when nothing was compacted.
 * Runs after every run and, for an oversized start, before one.
 */
export async function compactThread(input: {
  store: ThreadStore;
  threadId: string;
  model: string;
  envelopes: LedgerEnvelope[];
  report: ContextReport;
}): Promise<Snapshot | null> {
  const { store, envelopes, report } = input;
  if (!report.needsCompaction) return null;
  const { budget, layers, occupiedTokens } = report;
  const historyTokens =
    layers.find((layer) => layer.id === 'conversation')?.tokens ?? 0;
  const fixedTokens = Math.max(0, occupiedTokens - historyTokens);
  const targetTokens = Math.max(
    1,
    (budget.windowTokens - budget.outputReserveTokens) * budget.compactToRatio -
      fixedTokens,
  );
  const throughSeq = chooseCompactThroughSeqForTarget(
    envelopes,
    budget.keepToolResultsForTurns,
    targetTokens,
  );
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
  runManager.get(runId)?.emitter.emit({
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

export async function maybeCompactThread(input: {
  threadId: string;
  runId: string;
  model: string;
  webSearch?: boolean;
  endpoint?: OllamaEndpoint;
}): Promise<void> {
  const store = await getThreadStore();
  const thread = store.getThread(input.threadId);
  if (!thread) return;
  const envelopes = await store.hydrateEnvelopes(input.threadId);
  const lastUser = lastUserEnvelope(envelopes);
  const prepared = await prepareRun({
    threadId: input.threadId,
    thread,
    webSearch: input.webSearch,
    lastUserSeq: store.lastUserSeq(envelopes) ?? 0,
    envelopes,
    model: input.model,
    endpoint: input.endpoint,
    skillNames: resolveRequestedSkills(undefined, lastUser?.skills?.selected),
  });
  if (!prepared.report.needsCompaction) return;
  runManager.get(input.runId)?.emitter.emit({
    type: 'context.compacting',
    runId: input.runId,
    threadId: input.threadId,
  });
  const snapshot = await compactThread({
    store,
    threadId: input.threadId,
    model: input.model,
    envelopes,
    report: prepared.report,
  });
  if (snapshot) emitCompacted(store, input.runId, input.threadId, snapshot);
}

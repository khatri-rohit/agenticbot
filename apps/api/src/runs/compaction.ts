import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';

import type {
  ContextReport,
  HarnessFlags,
  LedgerEnvelope,
  OllamaEndpoint,
  Snapshot,
} from '@agent/agent-models';
import {
  acceptSectionedSummary,
  buildExtractiveSnapshot,
  buildSummaryMessages,
  getClient,
  getOllamaModelConfig,
  planCompaction,
  resolveReasoningEffort,
  traceCompactionEvent,
} from '@agent/agent-core';

import { runManager } from '../platform/instances';
import { threadTraceSink } from '../platform/trace-sink.js';
import type { ThreadStore } from '../threads/thread-store';

/** Bounds the summary call. Pre-run compaction waits on it, so the user does too. */
const SUMMARY_TIMEOUT_MS = 20_000;
const SUMMARY_MAX_TOKENS = 1_500;

/**
 * AGENT_MODEL_FAST (a cloud id) on cloud runs; the run's own model on local
 * runs, where a cloud id would not exist.
 */
function summaryModelFor(runModel: string, endpoint: OllamaEndpoint): string {
  const fast = process.env.AGENT_MODEL_FAST?.trim();
  return endpoint === 'cloud' && fast ? fast : runModel;
}

/** Thinking off when the model offers off: thinking tokens would eat max_tokens. */
async function summaryReasoningEffort(model: string, endpoint: OllamaEndpoint): Promise<string | undefined> {
  try {
    const config = await getOllamaModelConfig(model, endpoint);
    return config.thinking.values.includes(false) ? resolveReasoningEffort(config, false) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sectioned summary of the compacted turns, or null when the call fails,
 * times out, or the reply is not in shape (the caller keeps the extractive
 * summary). Never throws.
 */
async function sectionedSummary(input: {
  model: string;
  endpoint: OllamaEndpoint;
  envelopes: LedgerEnvelope[];
  throughSeq: number;
  previous: Snapshot | null;
}): Promise<string | null> {
  try {
    const model = summaryModelFor(input.model, input.endpoint);
    const reasoningEffort = await summaryReasoningEffort(model, input.endpoint);
    const params = {
      model,
      messages: buildSummaryMessages(input),
      max_tokens: SUMMARY_MAX_TOKENS,
      temperature: 0.2,
      ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    };
    const completion = await getClient(input.endpoint).chat.completions.create(
      params as ChatCompletionCreateParamsNonStreaming,
      { signal: AbortSignal.timeout(SUMMARY_TIMEOUT_MS) },
    );
    const reply = completion.choices[0]?.message?.content ?? '';
    return acceptSectionedSummary(reply, input.throughSeq);
  } catch (error) {
    console.warn(
      '[compaction] sectioned summary failed, keeping the extractive one:',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

/**
 * Write the snapshot core's compaction decision asks for (see planCompaction).
 * Returns it, or null when nothing was compacted. Runs after every run that
 * was not cancelled and, for an oversized start, before one. The brief is
 * always extractive; the summary is sectioned when the flag is on and the
 * model call succeeds.
 */
export async function compactThread(input: {
  store: ThreadStore;
  threadId: string;
  model: string;
  endpoint: OllamaEndpoint;
  flags: HarnessFlags;
  envelopes: LedgerEnvelope[];
  report: ContextReport;
}): Promise<Snapshot | null> {
  const { store, envelopes } = input;
  const throughSeq = planCompaction(envelopes, input.report);
  if (throughSeq == null) return null;
  const existing = await store.readSnapshot(input.threadId);
  if (existing && existing.throughSeq >= throughSeq) return null;

  const extractive = buildExtractiveSnapshot({
    threadId: input.threadId,
    model: input.model,
    envelopes,
    throughSeq,
  });
  const sectioned = input.flags.sectionedSummary
    ? await sectionedSummary({
        model: input.model,
        endpoint: input.endpoint,
        envelopes,
        throughSeq,
        previous: existing,
      })
    : null;
  const snapshot: Snapshot = sectioned
    ? { ...extractive, summary: sectioned, promptVersion: 'sectioned-v1' }
    : extractive;
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
  endpoint: OllamaEndpoint;
  flags: HarnessFlags;
  report: ContextReport;
}): Promise<void> {
  if (!input.report.needsCompaction) return;
  const { store, threadId, runId } = input;
  runManager.publish(runId, { type: 'context.compacting', runId, threadId });
  const snapshot = await compactThread({
    store,
    threadId,
    model: input.model,
    endpoint: input.endpoint,
    flags: input.flags,
    envelopes: await store.hydrateEnvelopes(threadId),
    report: input.report,
  });
  if (snapshot) emitCompacted(store, runId, threadId, snapshot);
}

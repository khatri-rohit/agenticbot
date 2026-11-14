import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';

import type {
  ContextReport,
  HarnessFlags,
  LedgerEnvelope,
  OllamaEndpoint,
  ResolvedModelSettings,
  SideCallThinking,
  Snapshot,
} from '@agent/agent-models';
import {
  acceptSectionedSummary,
  buildExtractiveSnapshot,
  buildSummaryMessages,
  foldedTranscript,
  getClient,
  getOllamaModelConfig,
  planCompaction,
  sideCallReasoningEffort,
  traceCompactionEvent,
} from '@agent/agent-core';

import { sideCallBudget } from '../models/model-settings-store';
import { runManager } from '../platform/instances';
import { threadTraceSink } from '../platform/trace-sink.js';
import type { ThreadStore } from '../threads/thread-store';

/**
 * The summary model from the run's resolved settings (file > env > run's
 * model). Falls back to the run's own model when the host passed no
 * snapshot — the pre-settings behavior.
 */
function summaryModelFor(
  runModel: string,
  endpoint: OllamaEndpoint,
  modelSettings: ResolvedModelSettings | undefined,
): string {
  const summary = modelSettings?.roles.summary;
  return summary && summary.source !== 'default' ? summary.model : runModel;
}

/**
 * Thinking preference from settings, mapped onto the model's own values.
 * `off` keeps the pre-settings behavior: thinking off when the model offers
 * off, because thinking tokens would eat max_tokens.
 */
async function summaryReasoningEffort(
  model: string,
  endpoint: OllamaEndpoint,
  thinking: SideCallThinking,
): Promise<string | undefined> {
  try {
    const config = await getOllamaModelConfig(model, endpoint);
    return sideCallReasoningEffort(config, thinking);
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
  modelSettings: ResolvedModelSettings | undefined;
}): Promise<string | null> {
  try {
    const model = summaryModelFor(input.model, input.endpoint, input.modelSettings);
    const thinking = input.modelSettings?.thinking.summary ?? 'off';
    const reasoningEffort = await summaryReasoningEffort(model, input.endpoint, thinking);
    const budget = sideCallBudget(thinking);
    const params = {
      model,
      messages: buildSummaryMessages(input),
      max_tokens: budget.maxTokens,
      temperature: 0.2,
      ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    };
    const completion = await getClient(input.endpoint).chat.completions.create(
      params as ChatCompletionCreateParamsNonStreaming,
      { signal: AbortSignal.timeout(budget.timeoutMs) },
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
  modelSettings?: ResolvedModelSettings;
  /** Called once there is something to compact, before the summary call. */
  onStart?: () => void;
}): Promise<Snapshot | null> {
  const { store, envelopes } = input;
  const throughSeq = planCompaction(envelopes, input.report);
  if (throughSeq == null) return null;
  const existing = await store.readSnapshot(input.threadId);
  if (existing && existing.throughSeq >= throughSeq) return null;
  input.onStart?.();

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
        modelSettings: input.modelSettings,
      })
    : null;
  // The summary is lossy; the folded turns stay restorable from their blob.
  let transcriptSha: string | undefined;
  try {
    transcriptSha = await store.putBlob(input.threadId, foldedTranscript(envelopes, throughSeq));
  } catch (error) {
    console.warn('[compaction] transcript blob failed:', error instanceof Error ? error.message : error);
  }
  const snapshot: Snapshot = {
    ...(sectioned ? { ...extractive, summary: sectioned, promptVersion: 'sectioned-v1' } : extractive),
    ...(transcriptSha ? { transcriptSha } : {}),
  };
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
  modelSettings?: ResolvedModelSettings;
}): Promise<void> {
  if (!input.report.needsCompaction) return;
  const { store, threadId, runId } = input;
  const snapshot = await compactThread({
    store,
    threadId,
    model: input.model,
    endpoint: input.endpoint,
    flags: input.flags,
    envelopes: await store.hydrateEnvelopes(threadId),
    report: input.report,
    modelSettings: input.modelSettings,
    // Announced only when a snapshot will follow: over the mark with nothing
    // left to fold (one long last turn, or a snapshot that already covers
    // it) would leave the client's "compacting" notice on with no end.
    onStart: () => runManager.publish(runId, { type: 'context.compacting', runId, threadId }),
  });
  if (snapshot) emitCompacted(store, runId, threadId, snapshot);
}

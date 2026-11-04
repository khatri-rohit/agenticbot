import type { StartRunRequest } from '@agent/agent-models';
import {
  HOME_MODE,
  imageAttachments,
  isWorkspaceKind,
  lastRunFrom,
  normalizeRunPosture,
  parseContextWindowMode,
  planHasOpenWork,
  SYSTEM1_AUTO_THINKING,
} from '@agent/agent-models';
import {
  buildEffortPolicy,
  type RunClaim,
  webTrustFromLedger,
  createStreamModelCall,
  createSubagentRunner,
  getOllamaModelConfig,
  modelOwnsAuto,
  peekOllamaModelConfig,
} from '@agent/agent-core';

import {
  appendUsageLog,
  capacityEnabled,
  capacitySnapshot,
  createCapacityGate,
} from '../models/capacity';
import { resolveCallOptions } from '../models/model-runtime';
import {
  getAgentHome,
  getThreadStore,
  runManager,
} from '../platform/instances';
import { threadTraceSink } from '../platform/trace-sink.js';
import { compactThread, emitCompacted, maybeCompactThread } from './compaction';
import {
  endpointFromLocal,
  lastUserEnvelope,
  prepareRun,
  resolveRequestedSkills,
  type MemoryUpdatedPayload,
  type PlanUpdatedPayload,
} from './run-context';
import { createSubagentHost } from './subagent-host';
import { system1EnforceAvailable, system1PortForRun } from './system1-runtime';
import { titleNewThread } from './thread-title';

export type StartRunResult =
  | { ok: true; runId: string }
  | {
      ok: false;
      /** invalid request · unknown thread · thread already running */
      reason: 'invalid' | 'not_found' | 'busy';
      error: string;
      /** The active run, when reason is busy. */
      runId?: string;
    };

function reject(
  reason: 'invalid' | 'not_found' | 'busy',
  error: string,
  runId?: string,
): StartRunResult {
  return {
    ok: false,
    reason,
    error,
    ...(runId !== undefined ? { runId } : {}),
  };
}

/**
 * Append the optional user turn to the thread's ledger and start a run on it:
 * admission, context (compacting an oversized start first), model and
 * thinking options, then everything that happens after the run finishes.
 * `request` is already parsed (parseStartRunRequest). Returns once the run is
 * started.
 */
export async function startThreadRun(
  request: StartRunRequest,
): Promise<StartRunResult> {
  // Claim before the first await, so two sends cannot both start a run.
  const claimed = runManager.claim(request.threadId);
  if (!claimed.ok) {
    return reject(
      'busy',
      'A run is already active for this thread',
      claimed.activeRunId,
    );
  }
  const { claim } = claimed;
  try {
    const result = await startClaimedRun(request, claim);
    if (!result.ok) claim.release();
    return result;
  } catch (error) {
    claim.release();
    throw error;
  }
}

async function startClaimedRun(
  request: StartRunRequest,
  claim: RunClaim,
): Promise<StartRunResult> {
  const runId = claim.runId;
  if (!(await claim.ready)) {
    return reject('busy', 'The previous run on this thread is still stopping');
  }

  const {
    threadId,
    message,
    rewindThroughSeq,
    model,
    local,
    webSearch,
    thinking,
    posture: rawPosture,
    skills: rawSkills,
    contextWindowMode: rawWindowMode,
  } = request;
  const posture = normalizeRunPosture(rawPosture);

  const store = await getThreadStore();
  const found = store.getThread(threadId);
  if (!found) {
    return reject('not_found', 'Thread not found');
  }
  // The window decides when compaction runs, so it lives on the thread:
  // this run and the compaction after it read the same value.
  const windowMode = parseContextWindowMode(rawWindowMode);
  const thread =
    windowMode && windowMode !== (found.contextWindowMode ?? 'default')
      ? (store.updateThread(threadId, { contextWindowMode: windowMode }) ??
        found)
      : found;

  // Sub-agent threads are read-only — user cannot start runs on them (Q4).
  if (thread.parentThreadId) {
    return reject('invalid', 'Sub-agent threads are read-only');
  }

  if (isWorkspaceKind(thread.kind) && !thread.workspaceRoot) {
    return reject('invalid', 'workspace thread has no workspaceRoot');
  }

  if (rewindThroughSeq !== undefined) {
    await store.rewind(threadId, rewindThroughSeq);
  }

  const ledgerBefore = await store.readLedger(threadId, 0);
  const isFirstUserTurn = ledgerBefore.length === 0 && Boolean(message);
  const priorUser = lastUserEnvelope(ledgerBefore);
  const skillNames = resolveRequestedSkills(
    rawSkills,
    message ? undefined : priorUser?.skills?.selected,
  );

  const useModel = model ?? thread.model ?? HOME_MODE.model;
  const endpoint = endpointFromLocal(local);

  // Before the user row is written, so a refusal leaves the ledger as it was.
  if (
    imageAttachments(message?.attachments).length > 0 ||
    ledgerBefore.some((envelope) => imageAttachments(envelope.attachments).length > 0)
  ) {
    try {
      const config = await getOllamaModelConfig(useModel, endpoint);
      if (!config.supportsVision) {
        return reject(
          'invalid',
          'This model does not support images. Pick a vision model.',
        );
      }
    } catch {
      // If /api/show is unavailable, let the model provider reject instead.
    }
  }

  if (message) {
    await store.append({
      threadId,
      runId: null,
      record: { role: 'user', content: message.content },
      ...(message.attachments?.length
        ? { attachments: message.attachments }
        : {}),
      skills: { selected: skillNames },
    });
  }

  const envelopes = await store.hydrateEnvelopes(threadId);
  if (envelopes.length === 0) {
    return reject('invalid', 'thread has no messages');
  }

  const prepareInput = {
    threadId,
    thread,
    webSearch,
    posture,
    lastUserSeq: store.lastUserSeq(envelopes) ?? 0,
    envelopes,
    model: useModel,
    endpoint,
    skillNames,
    onMemoryUpdated: (payload: MemoryUpdatedPayload) =>
      runManager.publish(runId, { type: 'memory.updated', runId, ...payload }),
    onPlanUpdated: (payload: PlanUpdatedPayload) =>
      runManager.publish(runId, {
        type: 'plan.updated',
        runId,
        threadId,
        plan: payload.plan,
      }),
  };
  let prepared = await prepareRun(prepareInput);
  // Oversized start (window switched down, big mention, long last run):
  // compact before the first model call instead of carrying it all run.
  const preRunSnapshot = await compactThread({
    store,
    threadId,
    model: useModel,
    envelopes,
    report: prepared.report,
  });
  if (preRunSnapshot) prepared = await prepareRun(prepareInput);

  // Auto (System 1) starts from the model's default; the router moves from
  // there. A model that lists its own `auto` level gets that value instead.
  // Same guard resolveCallOptions applies, so the policy baseline and the
  // closed-over reasoning_effort always agree.
  const requestedThinking =
    typeof thinking === 'boolean' ||
    (typeof thinking === 'string' && thinking.length > 0)
      ? thinking
      : undefined;
  let callOptions = await resolveCallOptions(
    useModel,
    requestedThinking === SYSTEM1_AUTO_THINKING ? undefined : requestedThinking,
    endpoint,
    prepared.mode.temperature,
  );
  // Cached by resolveCallOptions; never refetched here, so a failed
  // /api/show costs nothing extra (the run then uses a fixed policy).
  const modelConfig = peekOllamaModelConfig(useModel, endpoint) ?? null;
  if (
    requestedThinking === SYSTEM1_AUTO_THINKING &&
    modelConfig &&
    modelOwnsAuto(modelConfig)
  ) {
    callOptions = await resolveCallOptions(
      useModel,
      requestedThinking,
      endpoint,
      prepared.mode.temperature,
    );
  }
  const modelCall = createStreamModelCall(callOptions);
  const effortPolicy = buildEffortPolicy(
    modelConfig,
    requestedThinking,
    system1EnforceAvailable(endpoint),
  );
  const system1 = system1PortForRun(endpoint, prepared.mode.limits.maxWallMs);
  // Cloud runs share one account: pause on a spent session/week instead of
  // erroring, and steer tighter when behind even weekly pace.
  const capacity =
    endpoint === 'cloud' && capacityEnabled()
      ? createCapacityGate()
      : undefined;
  const balanceBefore = capacitySnapshot();

  // Replaced in onFinished; survives only if the server stops mid-run.
  await store.writeLastRun(
    threadId,
    lastRunFrom({ runId, outcome: 'interrupted', iterations: 0, toolCalls: 0 }),
  );

  claim.start({
    model: useModel,
    messages: prepared.messages,
    tools: prepared.tools,
    modelCall,
    limits: prepared.mode.limits,
    mode: prepared.mode.name,
    posture: prepared.posture,
    estimatedPromptTokens: prepared.report.occupiedTokens,
    contextReport: prepared.report,
    contextBudget: prepared.report.budget,
    ...(thread.workspaceRoot ? { workspaceRoot: thread.workspaceRoot } : {}),
    putBlob: (text) => store.putBlob(threadId, text),
    readBlob: (sha256, offset, length) =>
      store.readBlobText(threadId, sha256, offset, length),
    onMessage: async (record, meta) => {
      if (record.role === 'system') return;
      await store.append({
        threadId,
        runId,
        record,
        ...(meta ? { meta } : {}),
      });
    },
    hasOpenPlanWork: async () =>
      planHasOpenWork(await store.readPlan(threadId)),
    // The loop binds the runner to this run (signal, budget, capabilities).
    ...(isWorkspaceKind(thread.kind) && thread.workspaceRoot
      ? {
          subagents: createSubagentRunner({
            runManager,
            host: createSubagentHost({ store, endpoint }),
          }),
        }
      : {}),
    trace: threadTraceSink(store, threadId),
    ...(skillNames.length > 0 ? { pinnedSkills: skillNames } : {}),
    ...(capacity ? { capacity } : {}),
    ...(system1 ? { system1 } : {}),
    effortPolicy,
    webTrust: webTrustFromLedger(envelopes),
  }, {
    onFinished: async (result, outcome) => {
      // Not awaited: the balance read after a run must not delay compaction.
      void appendUsageLog(getAgentHome(), {
        runId: result.runId,
        threadId,
        model: useModel,
        endpoint,
        status: result.status,
        ...(result.limitReason ? { limitReason: result.limitReason } : {}),
        usage: result.usage,
        balanceBefore,
      });
      try {
        await store.writeLastRun(
          threadId,
          lastRunFrom({
            runId,
            outcome,
            iterations: result.iterations,
            toolCalls: result.toolCalls,
            ...(result.limitReason ? { limitReason: result.limitReason } : {}),
            // Keeps the System 1 notice across a reload (the SSE event is live-only).
            ...(system1 ? { system1: system1.report() } : {}),
          }),
        );
      } catch (error) {
        console.error(
          'writeLastRun failed:',
          error instanceof Error ? error.message : error,
        );
      }
      // A cancelled run leaves compaction to the next run's pre-run pass, so
      // nothing it writes can race that run's rewind.
      if (outcome === 'cancelled' || !result.contextReport) return;
      await maybeCompactThread({
        store,
        threadId,
        runId,
        model: useModel,
        report: result.contextReport,
      });
    },
  });

  runManager.publish(runId, {
    type: 'plan.updated',
    runId,
    threadId,
    plan: await store.readPlan(threadId),
  });
  if (preRunSnapshot) emitCompacted(store, runId, threadId, preRunSnapshot);

  if (isFirstUserTurn && message) {
    titleNewThread(store, threadId, message.content || 'Image chat', useModel, endpoint);
  }

  return { ok: true, runId };
}

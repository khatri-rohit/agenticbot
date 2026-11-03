import type { StartRunRequest } from '@agent/agent-models';
import {
  HOME_MODE,
  imageAttachments,
  isWorkspaceKind,
  normalizeRunPosture,
  parseContextWindowMode,
  planHasOpenWork,
  SYSTEM1_AUTO_THINKING,
} from '@agent/agent-models';
import {
  RUN_HANDLE_TTL_MS,
  type RunManager,
  buildEffortPolicy,
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
import { generateThreadTitle } from './thread-title';

/** Map a RunLoopResult into the persisted last-run status + limit reason. */
function lastRunStatusFrom(
  result: {
    status: string;
    content: string;
    limitReason?: string;
    runId: string;
  },
  runManager: RunManager,
): {
  status: 'completed' | 'incomplete' | 'error';
  incomplete: boolean;
  limitReason?: string;
} {
  // Detect cancellation from the RunHandle flag, not from error text — the
  // string is produced elsewhere and coupling to it breaks if it changes.
  const cancelled =
    result.status === 'error' &&
    runManager.get(result.runId)?.cancelled === true;
  if (cancelled)
    return {
      status: 'incomplete',
      incomplete: true,
      limitReason: 'Run cancelled',
    };
  if (result.status === 'incomplete') {
    return {
      status: 'incomplete',
      incomplete: true,
      limitReason: result.limitReason,
    };
  }
  if (result.status === 'error') return { status: 'error', incomplete: false };
  return { status: 'completed', incomplete: false };
}

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
 * Returns once the run is started (and, on a first turn, the title is written).
 */
export async function startThreadRun(
  request: StartRunRequest,
): Promise<StartRunResult> {
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

  if (!threadId) {
    return reject('invalid', 'threadId is required');
  }

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

  if (runManager.hasActiveRun(threadId)) {
    return reject(
      'busy',
      'A run is already active for this thread',
      runManager.activeRunIdForThread(threadId),
    );
  }

  if (typeof rewindThroughSeq === 'number') {
    if (!Number.isInteger(rewindThroughSeq) || rewindThroughSeq < 0) {
      return reject(
        'invalid',
        'rewindThroughSeq must be a non-negative integer',
      );
    }
    await store.rewind(threadId, rewindThroughSeq);
  }

  const ledgerBefore = await store.readLedger(threadId, 0);
  const isFirstUserTurn = ledgerBefore.length === 0 && Boolean(message);
  const priorUser = lastUserEnvelope(ledgerBefore);
  const skillNames = resolveRequestedSkills(
    rawSkills,
    message ? undefined : priorUser?.skills?.selected,
  );

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

  const useModel = model ?? thread.model ?? HOME_MODE.model;
  const endpoint = endpointFromLocal(local);

  if (
    envelopes.some(
      (envelope) => imageAttachments(envelope.attachments).length > 0,
    )
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

  let assignedRunId = '';
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
    onMemoryUpdated: (payload: MemoryUpdatedPayload) => {
      const handle = runManager.get(assignedRunId);
      handle?.emitter.emit({
        type: 'memory.updated',
        runId: assignedRunId,
        ...payload,
      });
    },
    onPlanUpdated: (payload: PlanUpdatedPayload) => {
      const handle = runManager.get(assignedRunId);
      handle?.emitter.emit({
        type: 'plan.updated',
        runId: assignedRunId,
        threadId,
        plan: payload.plan,
      });
    },
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

  assignedRunId = runManager.start({
    threadId,
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
    readBlob: async (sha256, offset, length) => {
      const buf = await store.readBlob(threadId, sha256);
      const text = buf.toString('utf8');
      if (offset === undefined && length === undefined) return text;
      const start = offset ?? 0;
      return text.slice(
        start,
        length === undefined ? undefined : start + length,
      );
    },
    onMessage: async (record, meta) => {
      if (record.role === 'system') return;
      await store.append({
        threadId,
        runId: assignedRunId,
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
    onFinished: async (result) => {
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
        const runStatus = lastRunStatusFrom(result, runManager);
        // Keeps the System 1 notice across a reload (the SSE event is live-only).
        const system1Report = system1?.report();
        await store.writeLastRun(threadId, {
          runId: result.runId,
          status: runStatus.status,
          incomplete: runStatus.incomplete,
          iterations: result.iterations,
          toolCalls: result.toolCalls,
          finishedAt: new Date().toISOString(),
          ...(runStatus.limitReason
            ? { limitReason: runStatus.limitReason }
            : {}),
          ...(system1Report?.fallbacks.length
            ? { system1: system1Report }
            : {}),
        });
      } catch (error) {
        console.error(
          'writeLastRun failed:',
          error instanceof Error ? error.message : error,
        );
      }
      try {
        await maybeCompactThread({
          threadId,
          runId: assignedRunId,
          model: useModel,
          webSearch,
          endpoint,
        });
      } finally {
        setTimeout(() => {
          runManager.clear(assignedRunId);
        }, RUN_HANDLE_TTL_MS);
      }
    },
  });

  const started = runManager.get(assignedRunId);
  started?.emitter.emit({
    type: 'plan.updated',
    runId: assignedRunId,
    threadId,
    plan: await store.readPlan(threadId),
  });
  if (preRunSnapshot)
    emitCompacted(store, assignedRunId, threadId, preRunSnapshot);

  // First turn: title via TITLE_MODEL on cloud runs, else the run's model
  // (runs in parallel with the agent). Await so POST /run returns after
  // ThreadStore has the real title for refreshThreads.
  if (isFirstUserTurn && message) {
    const title = await generateThreadTitle(
      message.content || 'Image chat',
      useModel,
      endpoint,
    );
    store.updateThread(threadId, { title, model: useModel });
  }

  return { ok: true, runId: assignedRunId };
}

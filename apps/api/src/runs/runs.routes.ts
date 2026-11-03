import { Router, type Request, type Response } from 'express';
import type {
  ContextReport,
  LedgerEnvelope,
  MemoryTarget,
  MessageAttachment,
  ModeConfig,
  OllamaEndpoint,
  Snapshot,
  StartRunRequest,
  Thread,
  ThreadPlan,
} from '@agent/agent-models';
import {
  HOME_MODE,
  MAX_THREAD_MENTIONS,
  applyPostureToTools,
  imageAttachments,
  isWorkspaceKind,
  modeForKind,
  normalizeRunPosture,
  normalizeThreadKind,
  parseContextWindowMode,
  planHasOpenWork,
  threadMentions,
  type ContextWindowMode,
  type RunPosture,
  SYSTEM1_AUTO_THINKING,
} from '@agent/agent-models';
import {
  RUN_HANDLE_TTL_MS,
  RunManager,
  assembleContext,
  buildEffortPolicy,
  buildExtractiveSnapshot,
  chooseCompactThroughSeqForTarget,
  createMemoryTool,
  createPlanTools,
  createStreamModelCall,
  createSubagentRunner,
  createToolRegistry,
  getOllamaModelConfig,
  listTools,
  loadWorkspaceRules,
  modelOwnsAuto,
  packMentionedThread,
  peekOllamaModelConfig,
  getSkill,
  traceCompactionEvent,
  type MentionedThreadContext,
  type ToolRegistry,
} from '@agent/agent-core';
import {
  appendUsageLog,
  capacityEnabled,
  capacitySnapshot,
  createCapacityGate,
} from '../models/capacity';
import { generateThreadTitle } from './thread-title';
import {
  getAgentHome,
  getMemoryStore,
  getThreadStore,
  runManager,
} from '../platform/instances';
import { resolveCallOptions, resolveContextBudget } from '../models/model-runtime';
import { system1EnforceAvailable, system1PortForRun } from './system1-runtime';
import { createSubagentHost } from './subagent-host';
import { createJsonlTraceSink } from '../platform/trace-sink.js';
import type { ThreadStore } from '../threads/thread-store';

const router = Router();

/** Per-thread JSONL traces (`<thread>/traces/<runId>.jsonl`), plus console. */
function traceSinkFor(store: ThreadStore, threadId: string) {
  return createJsonlTraceSink(store.traceDir(threadId));
}

function toolAllowList(
  mode: ModeConfig,
  webSearch?: boolean,
  posture: RunPosture = 'agent',
): string[] {
  const names = [
    ...mode.globalTools,
    ...(webSearch !== false ? mode.allowedTools : []),
  ];
  return applyPostureToTools(names, posture);
}

function endpointFromLocal(local: boolean | undefined): OllamaEndpoint {
  return local === true ? 'local' : 'cloud';
}

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
  if (cancelled) return { status: 'incomplete', incomplete: true, limitReason: 'Run cancelled' };
  if (result.status === 'incomplete') {
    return { status: 'incomplete', incomplete: true, limitReason: result.limitReason };
  }
  if (result.status === 'error') return { status: 'error', incomplete: false };
  return { status: 'completed', incomplete: false };
}

async function loadMentionedThreads(
  store: ThreadStore,
  envelopes: LedgerEnvelope[],
  currentThreadId: string,
): Promise<MentionedThreadContext[]> {
  const lastUser = [...envelopes]
    .reverse()
    .find((envelope) => envelope.record.role === 'user');
  const mentions = threadMentions(lastUser?.attachments).slice(
    0,
    MAX_THREAD_MENTIONS,
  );
  const segments: MentionedThreadContext[] = [];
  const seen = new Set<string>();
  for (const mention of mentions) {
    if (mention.threadId === currentThreadId || seen.has(mention.threadId)) {
      continue;
    }
    seen.add(mention.threadId);
    const thread = store.getThread(mention.threadId);
    if (!thread) continue;
    const other = await store.hydrateEnvelopes(mention.threadId);
    const snapshot = await store.readSnapshot(mention.threadId);
    const sourceLabel = isWorkspaceKind(thread.kind)
      ? (thread.workspaceRoot ?? 'Workspace')
      : 'Home';
    segments.push({
      threadId: thread.id,
      title: thread.title || mention.title,
      sourceLabel,
      text: packMentionedThread({
        title: thread.title || mention.title,
        sourceLabel,
        envelopes: other,
        snapshot,
      }),
    });
  }
  return segments;
}

type MemoryUpdatedPayload = {
  opId: string;
  target: MemoryTarget;
  action: 'add' | 'patch' | 'remove';
};

type PlanUpdatedPayload = {
  plan: ThreadPlan;
};

function lastUserEnvelope(
  envelopes: LedgerEnvelope[],
): LedgerEnvelope | undefined {
  for (let i = envelopes.length - 1; i >= 0; i--) {
    if (envelopes[i].record.role === 'user') return envelopes[i];
  }
  return undefined;
}

function skillNameList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return names;
}

function resolveRequestedSkills(raw: unknown, stored?: string[]): string[] {
  const names =
    skillNameList(
      raw && typeof raw === 'object'
        ? (raw as { requested?: unknown }).requested
        : undefined,
    ) ?? stored;
  if (!names) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const skill = getSkill(name);
    if (!skill) continue;
    const key = skill.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(skill.name);
  }
  return out;
}

async function prepareRun(input: {
  threadId: string;
  thread?: Thread;
  webSearch?: boolean;
  posture?: RunPosture;
  lastUserSeq: number;
  envelopes: LedgerEnvelope[];
  model: string;
  endpoint?: OllamaEndpoint;
  skillNames?: string[];
  /** Overrides the thread's stored mode (estimate previews a change). */
  contextWindowMode?: ContextWindowMode;
  onMemoryUpdated?: (payload: MemoryUpdatedPayload) => void;
  onPlanUpdated?: (payload: PlanUpdatedPayload) => void;
}): Promise<{
  tools: ToolRegistry;
  messages: ReturnType<typeof assembleContext>['messages'];
  report: ReturnType<typeof assembleContext>['report'];
  mode: ModeConfig;
  posture: RunPosture;
}> {
  const memory = getMemoryStore();
  const kind = normalizeThreadKind(input.thread?.kind);
  const mode = modeForKind(kind);
  const workspace = isWorkspaceKind(kind);
  const workspaceRoot = workspace ? input.thread?.workspaceRoot : undefined;
  const files = await memory.read(workspaceRoot);
  const posture = workspace
    ? normalizeRunPosture(input.posture)
    : ('agent' as const);
  if (workspace && workspaceRoot) {
    const rules = await loadWorkspaceRules(workspaceRoot);
    files.agentsMd = rules.agentsMd;
    files.project = rules.project;
  }
  const store = await getThreadStore();
  const plan =
    input.threadId === 'draft' ? null : await store.readPlan(input.threadId);
  const planTools =
    input.threadId === 'draft'
      ? []
      : createPlanTools({
          read: () => store.readPlan(input.threadId),
          write: async (next) => {
            const saved = await store.writePlan(input.threadId, next);
            input.onPlanUpdated?.({ plan: saved });
            return saved;
          },
        });

  const tools = createToolRegistry(
    [
      ...listTools(),
      ...planTools,
      createMemoryTool({
        read: () => memory.read(workspaceRoot),
        apply: async (op) => {
          const applied = await memory.apply(op, workspaceRoot);
          input.onMemoryUpdated?.({
            opId: applied.id,
            target: applied.target,
            action: applied.action,
          });
          return applied;
        },
        stage: (op) => memory.stage(op, workspaceRoot),
        source: () => ({
          threadId: input.threadId,
          seq: input.lastUserSeq,
        }),
      }),
    ],
    toolAllowList(mode, input.webSearch, posture),
    posture,
  );

  const window = await resolveContextBudget(
    input.model,
    input.endpoint ?? 'cloud',
    input.contextWindowMode ?? input.thread?.contextWindowMode,
  );

  const snapshot =
    input.threadId === 'draft'
      ? null
      : await store.readSnapshot(input.threadId);

  const mentionedThreads = await loadMentionedThreads(
    store,
    input.envelopes,
    input.threadId,
  );

  const skillNames = input.skillNames ?? [];
  const lastRun =
    input.threadId === 'draft' ? null : await store.readLastRun(input.threadId);
  const { messages, report } = assembleContext(
    {
      tools,
      memory: files,
      snapshot,
      envelopes: input.envelopes,
      mode: mode.name,
      posture,
      mentionedThreads,
      skillNames,
      ...(plan ? { plan } : {}),
      ...(lastRun ? { lastRun } : {}),
    },
    window.budget,
  );

  return {
    tools,
    messages,
    report: { ...report, windowSource: window.source },
    mode,
    posture,
  };
}

/**
 * Extractive compaction (no LLM): when `report` says the thread is over
 * compactAtRatio, cut older turns until history fits compactToRatio and write
 * the snapshot. Returns the snapshot, or null when nothing was compacted.
 * Runs after every run and, for an oversized start, before one.
 */
async function compactThread(input: {
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
function emitCompacted(
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
  traceSinkFor(store, threadId)(
    traceCompactionEvent({ runId, threadId, snapshot }),
  );
}

async function maybeCompactThread(input: {
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

/**
 * POST /api/agent/run
 * Append optional user turn to the host ledger, then start a run.
 */
router.post('/run', async (req: Request, res: Response) => {
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
  } = req.body as StartRunRequest;
  const posture = normalizeRunPosture(rawPosture);

  if (!threadId) {
    return res.status(400).json({ error: 'threadId is required' });
  }

  const store = await getThreadStore();
  const found = store.getThread(threadId);
  if (!found) {
    return res.status(404).json({ error: 'Thread not found' });
  }
  // The window decides when compaction runs, so it lives on the thread:
  // this run and the compaction after it read the same value.
  const windowMode = parseContextWindowMode(rawWindowMode);
  const thread =
    windowMode && windowMode !== (found.contextWindowMode ?? 'default')
      ? (store.updateThread(threadId, { contextWindowMode: windowMode }) ?? found)
      : found;

  // Sub-agent threads are read-only — user cannot start runs on them (Q4).
  if (thread.parentThreadId) {
    return res
      .status(400)
      .json({ error: 'Sub-agent threads are read-only' });
  }

  if (isWorkspaceKind(thread.kind) && !thread.workspaceRoot) {
    return res
      .status(400)
      .json({ error: 'workspace thread has no workspaceRoot' });
  }

  if (runManager.hasActiveRun(threadId)) {
    return res.status(409).json({
      error: 'A run is already active for this thread',
      runId: runManager.activeRunIdForThread(threadId),
    });
  }

  if (typeof rewindThroughSeq === 'number') {
    if (!Number.isInteger(rewindThroughSeq) || rewindThroughSeq < 0) {
      return res
        .status(400)
        .json({ error: 'rewindThroughSeq must be a non-negative integer' });
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
    return res.status(400).json({ error: 'thread has no messages' });
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
        return res.status(400).json({
          error: 'This model does not support images. Pick a vision model.',
        });
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
    typeof thinking === 'boolean' || (typeof thinking === 'string' && thinking.length > 0)
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
  if (requestedThinking === SYSTEM1_AUTO_THINKING && modelConfig && modelOwnsAuto(modelConfig)) {
    callOptions = await resolveCallOptions(useModel, requestedThinking, endpoint, prepared.mode.temperature);
  }
  const modelCall = createStreamModelCall(callOptions);
  const effortPolicy = buildEffortPolicy(modelConfig, requestedThinking, system1EnforceAvailable(endpoint));
  const system1 = system1PortForRun(endpoint, prepared.mode.limits.maxWallMs);
  // Cloud runs share one account: pause on a spent session/week instead of
  // erroring, and steer tighter when behind even weekly pace.
  const capacity =
    endpoint === 'cloud' && capacityEnabled() ? createCapacityGate() : undefined;
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
    trace: traceSinkFor(store, threadId),
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
          ...(runStatus.limitReason ? { limitReason: runStatus.limitReason } : {}),
          ...(system1Report?.fallbacks.length ? { system1: system1Report } : {}),
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
  if (preRunSnapshot) emitCompacted(store, assignedRunId, threadId, preRunSnapshot);

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

  return res.json({ runId: assignedRunId });
});

/**
 * POST /api/agent/context/estimate
 * Same assembler as /run: host ledger + memory files + optional draft.
 */
router.post('/context/estimate', async (req: Request, res: Response) => {
  const {
    threadId,
    draft,
    attachments,
    model,
    webSearch,
    local,
    posture,
    skills: rawSkills,
    contextWindowMode,
  } = req.body as {
    threadId?: string;
    draft?: string;
    attachments?: MessageAttachment[];
    model?: string;
    webSearch?: boolean;
    local?: boolean;
    posture?: RunPosture;
    skills?: StartRunRequest['skills'];
    contextWindowMode?: unknown;
  };
  const previewWindowMode = parseContextWindowMode(contextWindowMode);

  const store = await getThreadStore();
  let envelopes: LedgerEnvelope[] = [];
  const id =
    typeof threadId === 'string' && threadId.trim() ? threadId.trim() : 'draft';

  if (id !== 'draft') {
    const thread = store.getThread(id);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });
    envelopes = await store.hydrateEnvelopes(id);
  }

  const trimmed = typeof draft === 'string' ? draft.trim() : '';
  if (trimmed || (attachments?.length ?? 0) > 0) {
    const seq = (envelopes.at(-1)?.seq ?? 0) + 1;
    envelopes = [
      ...envelopes,
      {
        v: 1,
        seq,
        ts: new Date().toISOString(),
        threadId: id,
        runId: null,
        record: { role: 'user', content: trimmed },
        ...(attachments?.length ? { attachments } : {}),
      },
    ];
  }

  const estimateThread = id === 'draft' ? undefined : store.getThread(id);
  const useModel = model ?? estimateThread?.model ?? HOME_MODE.model;
  const { report } = await prepareRun({
    threadId: id,
    thread: estimateThread,
    webSearch,
    posture: normalizeRunPosture(posture),
    lastUserSeq: store.lastUserSeq(envelopes) ?? 0,
    envelopes,
    model: useModel,
    endpoint: endpointFromLocal(local),
    skillNames: resolveRequestedSkills(rawSkills),
    ...(previewWindowMode ? { contextWindowMode: previewWindowMode } : {}),
  });

  return res.json({
    estimatedPromptTokens: report.occupiedTokens,
    contextLength: report.budget.windowTokens,
    source: 'estimate' as const,
    contextReport: report,
  });
});

/**
 * POST /api/agent/run/:runId/cancel
 * Cancel an in-flight run so the thread can accept a new run.
 */
router.post('/run/:runId/cancel', (req: Request, res: Response) => {
  const { runId } = req.params;
  const ok = runManager.cancel(runId);
  if (!ok) {
    return res.status(404).json({ error: 'Run not found or not active' });
  }
  return res.json({ ok: true });
});

function parseChoiceOptionIds(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) return null;
    ids.push(item.trim());
  }
  return ids;
}

/**
 * POST /api/agent/run/:runId/choice
 * Continue with selected options + extra text, or skip (run ends incomplete).
 */
router.post('/run/:runId/choice', (req: Request, res: Response) => {
  const { runId } = req.params;
  const body = req.body as {
    choiceId?: unknown;
    skipped?: unknown;
    optionIds?: unknown;
    text?: unknown;
  };
  const choiceId =
    typeof body.choiceId === 'string' ? body.choiceId.trim() : '';
  if (!choiceId) {
    return res.status(400).json({ error: 'choiceId is required' });
  }

  if (body.skipped === true) {
    const skipped = runManager.resolveChoice(runId, choiceId, {
      skipped: true,
    });
    if (skipped !== 'ok') {
      return res.status(404).json({
        error: 'Choice not found or already resolved',
      });
    }
    return res.json({ ok: true });
  }

  const optionIds = parseChoiceOptionIds(body.optionIds);
  if (optionIds === null) {
    return res.status(400).json({ error: 'optionIds must be a string array' });
  }
  const result = runManager.resolveChoice(runId, choiceId, {
    optionIds,
    ...(typeof body.text === 'string' ? { text: body.text } : {}),
  });

  if (result === 'invalid') {
    return res.status(400).json({
      error:
        'Select at least one option or enter text, with matching option ids',
    });
  }
  if (result !== 'ok') {
    return res.status(404).json({
      error: 'Choice not found or already resolved',
    });
  }
  return res.json({ ok: true });
});

/**
 * GET /api/agent/run/:runId/events?fromSeq=N
 * SSE stream of AgentEvents for a run.
 *
 * Replays buffered events from seq > fromSeq, then streams live events.
 */
router.get('/run/:runId/events', (req: Request, res: Response) => {
  const { runId } = req.params;
  const fromSeq = Number(req.query.fromSeq ?? 0);

  const handle = runManager.get(runId);
  if (!handle) {
    return res.status(404).json({ error: 'Run not found' });
  }

  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  // Write a comment to flush headers immediately
  res.write(': connected\n\n');

  // Subscribe to events (replays + live)
  const unsubscribe = runManager.subscribe(runId, fromSeq, (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  // Already-finished run: send `done` so the client can close without
  // waiting for run.settled/run.error replay. Live runs close client-side
  // on those events; `done` is the fallback for the late-subscriber case.
  if (handle.status !== 'running') {
    res.write('event: done\ndata: {}\n\n');
    res.end();
    return;
  }

  // Clean up on client disconnect
  req.on('close', () => {
    unsubscribe();
  });

  return;
});

export { router as runsRouter };

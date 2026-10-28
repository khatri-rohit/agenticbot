import { Router, type Request, type Response } from 'express';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  LedgerEnvelope,
  MemoryTarget,
  MessageAttachment,
  ModeConfig,
  OllamaBalance,
  OllamaBalanceLegacy,
  OllamaBalanceModern,
  OllamaEndpoint,
  StartRunRequest,
  ThinkingValue,
  Thread,
  ThreadKind,
  ThreadPlan,
} from '@agent/agent-models';
import {
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_MEMORY_CAPS,
  HOME_MODE,
  MAX_THREAD_MENTIONS,
  applyPostureToTools,
  imageAttachments,
  isWorkspaceKind,
  modeForKind,
  normalizeRunPosture,
  normalizeThreadKind,
  parseThreadKind,
  planHasOpenWork,
  threadMentions,
  type RunPosture,
} from '@agent/agent-models';
import {
  ALL_TOOLS,
  RUN_HANDLE_TTL_MS,
  RunManager,
  assembleContext,
  buildExtractiveSnapshot,
  chooseCompactThroughSeq,
  createMemoryTool,
  createPlanTools,
  createStreamModelCall,
  createToolRegistry,
  getOllamaModelConfig,
  listOllamaModels,
  loadWorkspaceRules,
  nativeOllamaBaseUrl,
  packMentionedThread,
  resolveReasoningEffort,
  getSkill,
  traceCompactionEvent,
  type MentionedThreadContext,
  type ToolRegistry,
} from '@agent/agent-core';
import { generateThreadTitle } from '../../lib/generate-thread-title';
import { pickFolderDialog } from '../../lib/pick-folder';
import { getMemoryStore, getThreadStore } from '../../lib/store-instance';
import { createJsonlTraceSink } from '../../lib/trace-sink.js';
import { skillsRouter } from './skills.routes';
import type { ThreadStore } from '../../lib/thread-store';

const router = Router();
router.use(skillsRouter);
const runManager = new RunManager();

/** Cached Ollama Cloud balance — 60s TTL to stay within the 10 req/min limit. */
let balanceCache: { data: OllamaBalance; expiresAt: number } | null = null;
const BALANCE_TTL_MS = 60_000;

type RawBalanceIncluded = {
  balance_usd?: number;
  allowance_usd?: number;
  period?: { from?: string; until?: string };
  session?: { remaining_percent?: number; resets_at?: string };
  weekly?: { remaining_percent?: number; resets_at?: string };
};

type RawBalanceResponse = {
  included?: RawBalanceIncluded;
  purchased?: { balance_usd?: number };
};

function parseBalance(raw: RawBalanceResponse): OllamaBalance {
  const included = raw.included ?? {};
  const result: OllamaBalance = {};

  if (included.session && included.weekly) {
    const legacy: OllamaBalanceLegacy = {
      session: {
        remainingPercent: included.session.remaining_percent ?? 0,
        resetsAt: included.session.resets_at ?? '',
      },
      weekly: {
        remainingPercent: included.weekly.remaining_percent ?? 0,
        resetsAt: included.weekly.resets_at ?? '',
      },
    };
    result.legacy = legacy;
  } else if (
    typeof included.balance_usd === 'number' &&
    typeof included.allowance_usd === 'number'
  ) {
    const modern: OllamaBalanceModern = {
      balanceUsd: included.balance_usd,
      allowanceUsd: included.allowance_usd,
      period: {
        from: included.period?.from ?? '',
        until: included.period?.until ?? '',
      },
    };
    result.modern = modern;
  }

  if (typeof raw.purchased?.balance_usd === 'number') {
    result.purchasedUsd = raw.purchased.balance_usd;
  }

  return result;
}

router.get('/usage/balance', async (_req: Request, res: Response) => {
  if (!process.env.OLLAMA_API_KEY) {
    res.status(404).json({ error: 'No OLLAMA_API_KEY configured' });
    return;
  }

  if (balanceCache && Date.now() < balanceCache.expiresAt) {
    res.json(balanceCache.data);
    return;
  }

  try {
    const base = nativeOllamaBaseUrl('cloud');
    const response = await fetch(`${base}/api/balance`, {
      headers: { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      res.status(response.status).json({
        error: `Ollama balance API returned ${response.status}`,
      });
      return;
    }

    const raw = (await response.json().catch(() => ({}))) as RawBalanceResponse;
    const data = parseBalance(raw);
    balanceCache = { data, expiresAt: Date.now() + BALANCE_TTL_MS };
    res.json(data);
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Balance fetch failed',
    });
  }
});

/** Per-run JSONL trace files for offline replay / eval debugging. */
const traceSink = createJsonlTraceSink(
  path.join(__dirname, '..', '..', '..', 'traces'),
);

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

async function resolveWorkspaceDir(
  raw: string,
): Promise<{ ok: true; root: string } | { ok: false; error: string }> {
  const root = path.resolve(raw.trim());
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      return { ok: false, error: 'workspaceRoot must be a directory' };
    }
  } catch {
    return { ok: false, error: `workspaceRoot does not exist: ${root}` };
  }
  return { ok: true, root: path.normalize(root) };
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

/** Returns null when the query is present but not a known endpoint. */
function parseEndpointQuery(
  value: unknown,
  fallback: OllamaEndpoint,
): OllamaEndpoint | null {
  if (value === undefined || value === '') return fallback;
  if (value === 'cloud' || value === 'local') return value;
  return null;
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
      ...ALL_TOOLS,
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

  let windowTokens = DEFAULT_CONTEXT_BUDGET.windowTokens;
  let windowSource: 'show' | 'default' = 'default';
  try {
    const config = await getOllamaModelConfig(
      input.model,
      input.endpoint ?? 'cloud',
    );
    if (config.contextLength) {
      windowTokens = config.contextLength;
      windowSource = 'show';
    }
  } catch {
    // Keep the default window when /api/show is unavailable.
  }

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
    { ...DEFAULT_CONTEXT_BUDGET, windowTokens },
  );

  return {
    tools,
    messages,
    report: { ...report, windowSource },
    mode,
    posture,
  };
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
  const throughSeq = chooseCompactThroughSeq(
    envelopes,
    prepared.report.budget.keepToolResultsForTurns,
  );
  if (throughSeq == null) return;
  const existing = await store.readSnapshot(input.threadId);
  if (existing && existing.throughSeq >= throughSeq) return;

  const emitter = runManager.get(input.runId)?.emitter;
  emitter?.emit({
    type: 'context.compacting',
    runId: input.runId,
    threadId: input.threadId,
  });

  const snapshot = buildExtractiveSnapshot({
    threadId: input.threadId,
    model: input.model,
    envelopes,
    throughSeq,
  });
  await store.writeSnapshot(input.threadId, snapshot);
  emitter?.emit({
    type: 'context.compacted',
    runId: input.runId,
    threadId: input.threadId,
    throughSeq: snapshot.throughSeq,
    brief: snapshot.brief,
    summary: snapshot.summary,
    createdAt: snapshot.createdAt,
  });
  traceSink(
    traceCompactionEvent({
      runId: input.runId,
      threadId: input.threadId,
      snapshot,
    }),
  );
}

/**
 * POST /api/agent/workspace/pick
 * Opens a native folder dialog on the API host and returns the absolute path.
 * 204 = cancelled, 500 = dialog failed, 200 = { workspaceRoot }.
 */
router.post('/workspace/pick', async (req: Request, res: Response) => {
  const initial =
    typeof req.body?.initialDir === 'string' && req.body.initialDir.trim()
      ? path.resolve(req.body.initialDir.trim())
      : undefined;
  const picked = await pickFolderDialog(initial);
  if (!picked.ok && picked.reason === 'cancelled') {
    return res.status(204).send();
  }
  if (!picked.ok) {
    return res.status(500).json({
      error:
        picked.message ||
        'Folder picker failed. Restart the API on this machine and try again.',
    });
  }
  const resolved = await resolveWorkspaceDir(picked.path);
  if (!resolved.ok) {
    return res.status(400).json({ error: resolved.error });
  }
  return res.json({ workspaceRoot: resolved.root });
});

router.get('/threads', async (req: Request, res: Response) => {
  const store = await getThreadStore();
  const kind = parseThreadKind(req.query.kind);
  const workspaceRoot =
    typeof req.query.workspaceRoot === 'string' &&
    req.query.workspaceRoot.trim()
      ? path.resolve(req.query.workspaceRoot.trim())
      : undefined;
  return res.json({
    threads: store.listThreads({
      ...(kind ? { kind } : {}),
      ...(workspaceRoot ? { workspaceRoot } : {}),
    }),
  });
});

router.post('/threads', async (req: Request, res: Response) => {
  const model =
    typeof req.body?.model === 'string' && req.body.model.trim()
      ? req.body.model.trim()
      : HOME_MODE.model;
  const title =
    typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.trim()
      : 'New Chat';
  const kind = parseThreadKind(req.body?.kind) ?? 'home';
  let workspaceRoot: string | undefined;
  if (isWorkspaceKind(kind)) {
    const raw =
      typeof req.body?.workspaceRoot === 'string' ? req.body.workspaceRoot : '';
    if (!raw.trim()) {
      return res
        .status(400)
        .json({ error: 'workspaceRoot is required for workspace threads' });
    }
    const resolved = await resolveWorkspaceDir(raw);
    if (!resolved.ok) return res.status(400).json({ error: resolved.error });
    workspaceRoot = resolved.root;
  }
  const store = await getThreadStore();
  const thread = await store.createThread(model, title, {
    kind,
    workspaceRoot,
  });
  return res.status(201).json(thread);
});

router.get('/threads/:id', async (req: Request, res: Response) => {
  const store = await getThreadStore();
  const thread = store.getThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  return res.json(thread);
});

router.patch('/threads/:id', async (req: Request, res: Response) => {
  const store = await getThreadStore();
  const body = req.body as {
    title?: string;
    model?: string;
    pinned?: boolean;
    kind?: ThreadKind;
    workspaceRoot?: string | null;
  };
  let workspaceRoot = body.workspaceRoot;
  if (typeof workspaceRoot === 'string' && workspaceRoot.trim()) {
    const resolved = await resolveWorkspaceDir(workspaceRoot);
    if (!resolved.ok) return res.status(400).json({ error: resolved.error });
    workspaceRoot = resolved.root;
  }
  const kind = parseThreadKind(body.kind);
  const thread = store.updateThread(req.params.id, {
    ...(typeof body.title === 'string' ? { title: body.title } : {}),
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}),
    ...(kind ? { kind } : {}),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
  });
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  return res.json(thread);
});

router.delete('/threads/:id', async (req: Request, res: Response) => {
  const store = await getThreadStore();
  const ok = await store.deleteThread(req.params.id);
  if (!ok) return res.status(404).json({ error: 'Thread not found' });
  return res.json({ ok: true });
});

router.get('/threads/:id/ledger', async (req: Request, res: Response) => {
  const store = await getThreadStore();
  const thread = store.getThread(req.params.id);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const messages = await store.toUiMessages(req.params.id);
  const envelopes = await store.readLedger(req.params.id, 0);
  const lastSeq = envelopes.at(-1)?.seq ?? 0;
  const lastUserSeq = store.lastUserSeq(envelopes);
  const snapshot = await store.readSnapshot(req.params.id);
  const plan = await store.readPlan(req.params.id);
  const lastRun = await store.readLastRun(req.params.id);
  const activeRunId = runManager.activeRunIdForThread(req.params.id);
  return res.json({
    messages,
    lastSeq,
    lastUserSeq,
    snapshot,
    plan,
    ...(lastRun ? { lastRun } : {}),
    ...(activeRunId ? { activeRunId } : {}),
  });
});

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
  } = req.body as StartRunRequest;
  const posture = normalizeRunPosture(rawPosture);

  if (!threadId) {
    return res.status(400).json({ error: 'threadId is required' });
  }

  const store = await getThreadStore();
  const thread = store.getThread(threadId);
  if (!thread) {
    return res.status(404).json({ error: 'Thread not found' });
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
  const prepared = await prepareRun({
    threadId,
    thread,
    webSearch,
    posture,
    lastUserSeq: store.lastUserSeq(envelopes) ?? 0,
    envelopes,
    model: useModel,
    endpoint,
    skillNames,
    onMemoryUpdated: (payload) => {
      const handle = runManager.get(assignedRunId);
      handle?.emitter.emit({
        type: 'memory.updated',
        runId: assignedRunId,
        ...payload,
      });
    },
    onPlanUpdated: (payload) => {
      const handle = runManager.get(assignedRunId);
      handle?.emitter.emit({
        type: 'plan.updated',
        runId: assignedRunId,
        threadId,
        plan: payload.plan,
      });
    },
  });

  const callOptions = await resolveCallOptions(
    useModel,
    thinking,
    endpoint,
    prepared.mode.temperature,
  );
  const modelCall = createStreamModelCall(callOptions);

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
    trace: traceSink,
    onFinished: async (result) => {
      try {
        const runStatus = lastRunStatusFrom(result, runManager);
        await store.writeLastRun(threadId, {
          runId: result.runId,
          status: runStatus.status,
          incomplete: runStatus.incomplete,
          iterations: result.iterations,
          toolCalls: result.toolCalls,
          finishedAt: new Date().toISOString(),
          ...(runStatus.limitReason ? { limitReason: runStatus.limitReason } : {}),
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

  // First turn: title via the same chat model (runs in parallel with the agent).
  // Await so POST /run returns after ThreadStore has the real title for refreshThreads.
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
  } = req.body as {
    threadId?: string;
    draft?: string;
    attachments?: MessageAttachment[];
    model?: string;
    webSearch?: boolean;
    local?: boolean;
    posture?: RunPosture;
    skills?: StartRunRequest['skills'];
  };

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
  });

  return res.json({
    estimatedPromptTokens: report.occupiedTokens,
    contextLength: report.budget.windowTokens,
    source: 'estimate' as const,
    contextReport: report,
  });
});

router.get('/memory', async (req: Request, res: Response) => {
  const memory = getMemoryStore();
  const workspaceRoot =
    typeof req.query.workspaceRoot === 'string' &&
    req.query.workspaceRoot.trim()
      ? req.query.workspaceRoot.trim()
      : undefined;
  const [files, ops] = await Promise.all([
    memory.read(workspaceRoot),
    memory.listOps(),
  ]);
  const reverted = new Set(
    ops
      .filter((op) => op.reason.startsWith('revert '))
      .map((op) => op.reason.slice('revert '.length)),
  );
  const visible = ops.filter(
    (op) =>
      op.status === 'applied' &&
      !reverted.has(op.id) &&
      !op.reason.startsWith('revert '),
  );
  return res.json({ files, ops: visible, caps: DEFAULT_MEMORY_CAPS });
});

router.patch('/memory', async (req: Request, res: Response) => {
  const user = typeof req.body?.user === 'string' ? req.body.user : undefined;
  if (user === undefined) {
    return res.status(400).json({ error: 'user is required' });
  }
  const threadId =
    typeof req.body?.threadId === 'string' && req.body.threadId.trim()
      ? req.body.threadId.trim()
      : 'settings';
  try {
    const op = await getMemoryStore().writeUser(user, { threadId, seq: 0 });
    return res.json({ op });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return res.status(400).json({ error: msg });
  }
});

router.post('/memory/revert', async (req: Request, res: Response) => {
  const opId = typeof req.body?.opId === 'string' ? req.body.opId.trim() : '';
  if (!opId) return res.status(400).json({ error: 'opId is required' });
  try {
    const op = await getMemoryStore().revert(opId);
    return res.json({ op });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return res.status(400).json({ error: msg });
  }
});

/**
 * GET /api/agent/models/config?model=&endpoint=local|cloud
 * Proxy for Ollama /api/show (context length, thinking values).
 * Registered before /models so a future /models/:id never shadows this path.
 */
router.get('/models/config', async (req: Request, res: Response) => {
  const model =
    typeof req.query.model === 'string' ? req.query.model.trim() : '';
  if (!model) {
    return res.status(400).json({ error: 'model is required' });
  }
  // Default cloud when omitted (backward compatible with existing clients).
  const endpoint = parseEndpointQuery(req.query.endpoint, 'cloud');
  if (!endpoint) {
    return res
      .status(400)
      .json({ error: 'endpoint must be "local" or "cloud"' });
  }

  try {
    const config = await getOllamaModelConfig(model, endpoint);
    return res.json(config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(502).json({ error: msg });
  }
});

/**
 * GET /api/agent/models?endpoint=local|cloud
 * Proxy for Ollama GET /api/tags (installed models). Defaults to local.
 */
router.get('/models', async (req: Request, res: Response) => {
  const endpoint = parseEndpointQuery(req.query.endpoint, 'local');
  if (!endpoint) {
    return res
      .status(400)
      .json({ error: 'endpoint must be "local" or "cloud"' });
  }
  try {
    const models = await listOllamaModels(endpoint);
    return res.json({ endpoint, models });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(502).json({ error: msg });
  }
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

async function resolveCallOptions(
  model: string,
  thinking: unknown,
  endpoint: OllamaEndpoint,
  temperature: number,
): Promise<{
  reasoningEffort?: string;
  endpoint: OllamaEndpoint;
  temperature: number;
}> {
  const requested: ThinkingValue | undefined =
    typeof thinking === 'boolean' ||
    (typeof thinking === 'string' && thinking.length > 0)
      ? thinking
      : undefined;

  try {
    const config = await getOllamaModelConfig(model, endpoint);
    const reasoningEffort = resolveReasoningEffort(config, requested);
    return {
      endpoint,
      temperature,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };
  } catch {
    // /api/show unavailable — omit effort; still route to the chosen endpoint
    return { endpoint, temperature };
  }
}

export { router as agentRouter };

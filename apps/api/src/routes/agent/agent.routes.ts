import { Router, type Request, type Response } from 'express';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  LedgerEnvelope,
  MemoryTarget,
  MessageAttachment,
  ModeConfig,
  OllamaEndpoint,
  StartRunRequest,
  ThinkingValue,
  Thread,
  ThreadKind,
} from '@org/agent-models';
import {
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_MEMORY_CAPS,
  HOME_MODE,
  isWorkspaceKind,
  normalizeThreadKind,
} from '@org/agent-models';
import {
  ALL_TOOLS,
  RunManager,
  assembleContext,
  buildExtractiveSnapshot,
  chooseCompactThroughSeq,
  createInvokeModelCall,
  createMemoryTool,
  createStreamModelCall,
  createToolRegistry,
  getOllamaModelConfig,
  listOllamaModels,
  loadWorkspaceRules,
  modeForKind,
  resolveReasoningEffort,
  type ToolRegistry,
} from '@org/agent-core';
import { generateThreadTitle } from '../../lib/generate-thread-title';
import { pickFolderDialog } from '../../lib/pick-folder';
import { getMemoryStore, getThreadStore } from '../../lib/store-instance';

const router = Router();
const runManager = new RunManager();

function toolAllowList(mode: ModeConfig, webSearch?: boolean): string[] {
  return [
    ...mode.globalTools,
    ...(webSearch !== false ? mode.allowedTools : []),
  ];
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
  return { ok: true, root };
}

function parseThreadKind(value: unknown): ThreadKind | undefined {
  if (
    value === 'home' ||
    value === 'workspace' ||
    value === 'research' ||
    value === 'coding'
  ) {
    return normalizeThreadKind(value);
  }
  return undefined;
}

function endpointFromLocal(local: boolean | undefined): OllamaEndpoint {
  return local === true ? 'local' : 'cloud';
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

async function prepareRun(input: {
  threadId: string;
  thread?: Thread;
  webSearch?: boolean;
  lastUserSeq: number;
  envelopes: LedgerEnvelope[];
  model: string;
  endpoint?: OllamaEndpoint;
  onMemoryUpdated?: (payload: MemoryUpdatedPayload) => void;
}): Promise<{
  tools: ToolRegistry;
  messages: ReturnType<typeof assembleContext>['messages'];
  report: ReturnType<typeof assembleContext>['report'];
  mode: ModeConfig;
}> {
  const memory = getMemoryStore();
  const files = await memory.read();
  const kind = normalizeThreadKind(input.thread?.kind);
  const mode = modeForKind(kind);
  if (isWorkspaceKind(kind) && input.thread?.workspaceRoot) {
    const rules = await loadWorkspaceRules(input.thread.workspaceRoot);
    files.agentsMd = rules.agentsMd;
    files.project = rules.project;
  }
  const tools = createToolRegistry(
    [
      ...ALL_TOOLS,
      createMemoryTool({
        read: () => memory.read(),
        apply: async (op) => {
          const applied = await memory.apply(op);
          input.onMemoryUpdated?.({
            opId: applied.id,
            target: applied.target,
            action: applied.action,
          });
          return applied;
        },
        stage: (op) => memory.stage(op),
        source: () => ({
          threadId: input.threadId,
          seq: input.lastUserSeq,
        }),
      }),
    ],
    toolAllowList(mode, isWorkspaceKind(kind) ? false : input.webSearch),
  );

  let windowTokens = DEFAULT_CONTEXT_BUDGET.windowTokens;
  try {
    const config = await getOllamaModelConfig(
      input.model,
      input.endpoint ?? 'cloud',
    );
    if (config.contextLength) windowTokens = config.contextLength;
  } catch {
    // Keep the default window when /api/show is unavailable.
  }

  const store = await getThreadStore();
  const snapshot =
    input.threadId === 'draft'
      ? null
      : await store.readSnapshot(input.threadId);

  const { messages, report } = assembleContext(
    {
      tools,
      memory: files,
      snapshot,
      envelopes: input.envelopes,
      mode: mode.name,
    },
    { ...DEFAULT_CONTEXT_BUDGET, windowTokens },
  );

  return { tools, messages, report, mode };
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
  const prepared = await prepareRun({
    threadId: input.threadId,
    thread,
    webSearch: input.webSearch,
    lastUserSeq: store.lastUserSeq(envelopes) ?? 0,
    envelopes,
    model: input.model,
    endpoint: input.endpoint,
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
  const thread = store.updateThread(req.params.id, {
    ...(typeof body.title === 'string' ? { title: body.title } : {}),
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}),
    ...(parseThreadKind(body.kind) ? { kind: parseThreadKind(body.kind) } : {}),
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
  return res.json({ messages, lastSeq, lastUserSeq, snapshot });
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
    streaming,
    model,
    local,
    webSearch,
    thinking,
  } = req.body as StartRunRequest;

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
    });
  }

  if (typeof rewindThroughSeq === 'number') {
    await store.rewind(threadId, rewindThroughSeq);
  }

  const ledgerBefore = await store.readLedger(threadId, 0);
  const isFirstUserTurn = ledgerBefore.length === 0 && Boolean(message);

  if (message) {
    await store.append({
      threadId,
      runId: null,
      record: { role: 'user', content: message.content },
      ...(message.attachments?.length
        ? { attachments: message.attachments }
        : {}),
    });
  }

  const envelopes = await store.hydrateEnvelopes(threadId);
  if (envelopes.length === 0) {
    return res.status(400).json({ error: 'thread has no messages' });
  }

  const useStreaming = streaming ?? true;
  const useModel = model ?? thread.model ?? HOME_MODE.model;
  const endpoint = endpointFromLocal(local);

  if (envelopes.some((envelope) => (envelope.attachments?.length ?? 0) > 0)) {
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
    lastUserSeq: store.lastUserSeq(envelopes) ?? 0,
    envelopes,
    model: useModel,
    endpoint,
    onMemoryUpdated: (payload) => {
      const handle = runManager.get(assignedRunId);
      handle?.emitter.emit({
        type: 'memory.updated',
        runId: assignedRunId,
        ...payload,
      });
    },
  });

  const callOptions = await resolveCallOptions(
    useModel,
    thinking,
    endpoint,
    prepared.mode.temperature,
  );
  const modelCall = useStreaming
    ? createStreamModelCall(callOptions)
    : createInvokeModelCall(callOptions);

  assignedRunId = runManager.start({
    threadId,
    model: useModel,
    streaming: useStreaming,
    messages: prepared.messages,
    tools: prepared.tools,
    modelCall,
    limits: prepared.mode.limits,
    mode: prepared.mode.name,
    estimatedPromptTokens: prepared.report.occupiedTokens,
    contextReport: prepared.report,
    ...(thread.workspaceRoot ? { workspaceRoot: thread.workspaceRoot } : {}),
    onMessage: async (record) => {
      if (record.role === 'system') return;
      await store.append({ threadId, runId: assignedRunId, record });
    },
    onFinished: () =>
      maybeCompactThread({
        threadId,
        runId: assignedRunId,
        model: useModel,
        webSearch,
        endpoint,
      }),
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
  const { threadId, draft, attachments, model, webSearch, local } =
    req.body as {
      threadId?: string;
      draft?: string;
      attachments?: MessageAttachment[];
      model?: string;
      webSearch?: boolean;
      local?: boolean;
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
    lastUserSeq: store.lastUserSeq(envelopes) ?? 0,
    envelopes,
    model: useModel,
    endpoint: endpointFromLocal(local),
  });

  return res.json({
    estimatedPromptTokens: report.occupiedTokens,
    contextLength: report.budget.windowTokens,
    source: 'estimate' as const,
    contextReport: report,
  });
});

router.get('/memory', async (_req: Request, res: Response) => {
  const memory = getMemoryStore();
  const [files, ops] = await Promise.all([memory.read(), memory.listOps()]);
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

  // If the run is already complete, send a final ping and close
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

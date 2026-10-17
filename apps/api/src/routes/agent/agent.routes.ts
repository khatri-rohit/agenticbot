import { Router, type Request, type Response } from 'express';
import type {
  LedgerEnvelope,
  MemoryTarget,
  MessageAttachment,
  StartRunRequest,
  ThinkingValue,
} from '@org/agent-models';
import {
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_MEMORY_CAPS,
} from '@org/agent-models';
import {
  ALL_TOOLS,
  RunManager,
  assembleContext,
  createInvokeModelCall,
  createMemoryTool,
  createStreamModelCall,
  createToolRegistry,
  getOllamaModelConfig,
  RESEARCH_MODE,
  resolveReasoningEffort,
  type ToolRegistry,
} from '@org/agent-core';
import { generateThreadTitle } from '../../lib/generate-thread-title';
import { getMemoryStore, getThreadStore } from '../../lib/store-instance';

const router = Router();
const runManager = new RunManager();

function toolAllowList(webSearch?: boolean): string[] {
  return [
    ...RESEARCH_MODE.globalTools,
    ...(webSearch !== false ? RESEARCH_MODE.allowedTools : []),
  ];
}

type MemoryUpdatedPayload = {
  opId: string;
  target: MemoryTarget;
  action: 'add' | 'patch' | 'remove';
};

async function prepareRun(input: {
  threadId: string;
  webSearch?: boolean;
  lastUserSeq: number;
  envelopes: LedgerEnvelope[];
  model: string;
  onMemoryUpdated?: (payload: MemoryUpdatedPayload) => void;
}): Promise<{
  tools: ToolRegistry;
  messages: ReturnType<typeof assembleContext>['messages'];
  report: ReturnType<typeof assembleContext>['report'];
}> {
  const memory = getMemoryStore();
  const files = await memory.read();
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
    toolAllowList(input.webSearch),
  );

  let windowTokens = DEFAULT_CONTEXT_BUDGET.windowTokens;
  try {
    const config = await getOllamaModelConfig(input.model);
    if (config.contextLength) windowTokens = config.contextLength;
  } catch {
    // Keep the default window when /api/show is unavailable.
  }

  const { messages, report } = assembleContext(
    {
      tools,
      memory: files,
      snapshot: null,
      envelopes: input.envelopes,
    },
    { ...DEFAULT_CONTEXT_BUDGET, windowTokens },
  );

  return { tools, messages, report };
}

router.get('/threads', async (_req: Request, res: Response) => {
  const store = await getThreadStore();
  return res.json({ threads: store.listThreads() });
});

router.post('/threads', async (req: Request, res: Response) => {
  const model =
    typeof req.body?.model === 'string' && req.body.model.trim()
      ? req.body.model.trim()
      : RESEARCH_MODE.model;
  const title =
    typeof req.body?.title === 'string' && req.body.title.trim()
      ? req.body.title.trim()
      : 'New Chat';
  const store = await getThreadStore();
  const thread = await store.createThread(model, title);
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
  };
  const thread = store.updateThread(req.params.id, {
    ...(typeof body.title === 'string' ? { title: body.title } : {}),
    ...(typeof body.model === 'string' ? { model: body.model } : {}),
    ...(typeof body.pinned === 'boolean' ? { pinned: body.pinned } : {}),
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
  return res.json({ messages, lastSeq, lastUserSeq });
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
  const useModel = model ?? thread.model ?? RESEARCH_MODE.model;

  if (envelopes.some((envelope) => (envelope.attachments?.length ?? 0) > 0)) {
    try {
      const config = await getOllamaModelConfig(useModel);
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
    webSearch,
    lastUserSeq: store.lastUserSeq(envelopes) ?? 0,
    envelopes,
    model: useModel,
    onMemoryUpdated: (payload) => {
      const handle = runManager.get(assignedRunId);
      handle?.emitter.emit({
        type: 'memory.updated',
        runId: assignedRunId,
        ...payload,
      });
    },
  });

  const callOptions = await resolveCallOptions(useModel, thinking);
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
    limits: RESEARCH_MODE.limits,
    mode: RESEARCH_MODE.name,
    estimatedPromptTokens: prepared.report.occupiedTokens,
    contextReport: prepared.report,
    onMessage: async (record) => {
      if (record.role === 'system') return;
      await store.append({ threadId, runId: assignedRunId, record });
    },
  });

  // First turn: title via the same chat model (runs in parallel with the agent).
  // Await so POST /run returns after ThreadStore has the real title for refreshThreads.
  if (isFirstUserTurn && message) {
    const title = await generateThreadTitle(
      message.content || 'Image chat',
      useModel,
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
  const { threadId, draft, attachments, model, webSearch } = req.body as {
    threadId?: string;
    draft?: string;
    attachments?: MessageAttachment[];
    model?: string;
    webSearch?: boolean;
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

  const useModel = model ?? RESEARCH_MODE.model;
  const { report } = await prepareRun({
    threadId: id,
    webSearch,
    lastUserSeq: store.lastUserSeq(envelopes) ?? 0,
    envelopes,
    model: useModel,
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
 * GET /api/agent/models/config?model=
 * Proxy for Ollama /api/show (context length, thinking values).
 */
router.get('/models/config', async (req: Request, res: Response) => {
  const model =
    typeof req.query.model === 'string' ? req.query.model.trim() : '';
  if (!model) {
    return res.status(400).json({ error: 'model is required' });
  }

  try {
    const config = await getOllamaModelConfig(model);
    return res.json(config);
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
): Promise<{ reasoningEffort: string } | undefined> {
  const requested: ThinkingValue | undefined =
    typeof thinking === 'boolean' ||
    (typeof thinking === 'string' && thinking.length > 0)
      ? thinking
      : undefined;

  try {
    const config = await getOllamaModelConfig(model);
    const reasoningEffort = resolveReasoningEffort(config, requested);
    return reasoningEffort !== undefined ? { reasoningEffort } : undefined;
  } catch {
    // /api/show unavailable — omit; provider keeps its default
    return undefined;
  }
}

export { router as agentRouter };

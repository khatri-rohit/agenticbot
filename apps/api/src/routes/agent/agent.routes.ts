import { Router, type Request, type Response } from 'express';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type {
  ChatMessage,
  MessageAttachment,
  StartRunRequest,
  ThinkingValue,
} from '@org/agent-models';
import {
  RunManager,
  createToolRegistry,
  ALL_TOOLS,
  buildSystemPrompt,
  createInvokeModelCall,
  createStreamModelCall,
  RESEARCH_MODE,
  getOllamaModelConfig,
  resolveReasoningEffort,
  estimatePromptTokens,
  type ToolRegistry,
} from '@org/agent-core';
import { generateThreadTitle } from '../../lib/generate-thread-title';
import { getThreadStore } from '../../lib/store-instance';

const router = Router();
const runManager = new RunManager();

/** Cap profile text at the API trust boundary (UI mirrors this). */
const USER_PERSONA_MAX_CHARS = 2000;

type BuildRunContextInput = {
  messages: ChatMessage[];
  /** Default true — omit RESEARCH_MODE.allowedTools when false. */
  webSearch?: boolean;
  userPersona?: string;
};

function buildRunContext(input: BuildRunContextInput): {
  tools: ToolRegistry;
  openaiMessages: ChatCompletionMessageParam[];
  estimatedPromptTokens: number;
} {
  const toolAllowList = [
    ...RESEARCH_MODE.globalTools,
    ...(input.webSearch !== false ? RESEARCH_MODE.allowedTools : []),
  ];
  const tools = createToolRegistry(ALL_TOOLS, toolAllowList);

  const persona =
    typeof input.userPersona === 'string'
      ? input.userPersona.trim().slice(0, USER_PERSONA_MAX_CHARS)
      : '';
  const openaiMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(tools, persona) },
    ...(input.messages as ChatCompletionMessageParam[]).filter(
      (message) => message.role !== 'system',
    ),
  ];

  return {
    tools,
    openaiMessages,
    estimatedPromptTokens: estimatePromptTokens(
      openaiMessages,
      tools.definitions,
    ),
  };
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
    userPersona,
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

  const history = await store.toChatMessages(threadId);
  if (history.length === 0) {
    return res.status(400).json({ error: 'thread has no messages' });
  }

  const useStreaming = streaming ?? true;
  const useModel = model ?? thread.model ?? RESEARCH_MODE.model;

  if (
    userMessageHasImages(message?.attachments) ||
    chatHasImageParts(history)
  ) {
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

  const { tools, openaiMessages, estimatedPromptTokens } = buildRunContext({
    messages: history,
    webSearch,
    userPersona,
  });

  const callOptions = await resolveCallOptions(useModel, thinking);
  const modelCall = useStreaming
    ? createStreamModelCall(callOptions)
    : createInvokeModelCall(callOptions);

  const runId = runManager.start({
    threadId,
    model: useModel,
    streaming: useStreaming,
    messages: openaiMessages,
    tools,
    modelCall,
    limits: RESEARCH_MODE.limits,
    mode: RESEARCH_MODE.name,
    estimatedPromptTokens,
    onMessage: async (record) => {
      if (record.role === 'system') return;
      await store.append({ threadId, runId, record });
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

  return res.json({ runId });
});

/**
 * POST /api/agent/context/estimate
 * Heuristic size of the next request envelope (same system + tools as /run).
 */
router.post('/context/estimate', async (req: Request, res: Response) => {
  const { messages, model, webSearch, userPersona } =
    req.body as Partial<StartRunRequest> & { messages?: ChatMessage[] };

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const useModel = model ?? RESEARCH_MODE.model;
  const { estimatedPromptTokens } = buildRunContext({
    messages,
    webSearch,
    userPersona,
  });

  let contextLength: number | null = null;
  try {
    const config = await getOllamaModelConfig(useModel);
    contextLength = config.contextLength;
  } catch {
    // Limit optional; client can fall back to static catalog.
  }

  return res.json({
    estimatedPromptTokens,
    contextLength,
    source: 'estimate' as const,
  });
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

function userMessageHasImages(
  attachments: MessageAttachment[] | undefined,
): boolean {
  return (attachments?.length ?? 0) > 0;
}

function chatHasImageParts(messages: ChatMessage[]): boolean {
  for (const message of messages) {
    if (message.role !== 'user' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === 'image_url') return true;
    }
  }
  return false;
}

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

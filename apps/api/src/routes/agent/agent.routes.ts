import { Router, type Request, type Response } from 'express';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type {
  ChatMessage,
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
import { titleQueue, type TitleJobData } from '../../queue/title-queue';

const router = Router();
const runManager = new RunManager();

/** Cap profile text at the API trust boundary (UI mirrors this). */
const USER_PERSONA_MAX_CHARS = 2000;

type BuildRunContextInput = {
  messages: ChatMessage[];
  allowedTools?: string[];
  userPersona?: string;
};

function buildRunContext(input: BuildRunContextInput): {
  tools: ToolRegistry;
  openaiMessages: ChatCompletionMessageParam[];
  estimatedPromptTokens: number;
} {
  const clientTools = Array.isArray(input.allowedTools)
    ? input.allowedTools
    : RESEARCH_MODE.allowedTools;
  const toolAllowList = [
    ...new Set([...clientTools, ...RESEARCH_MODE.globalTools]),
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

/**
 * POST /api/agent/run
 * Start a new agent run. Body: StartRunRequest. Returns: { runId: string }
 */
router.post('/run', async (req: Request, res: Response) => {
  const {
    threadId,
    messages,
    streaming,
    model,
    allowedTools,
    thinking,
    userPersona,
  } = req.body as StartRunRequest;

  if (!threadId) {
    return res.status(400).json({ error: 'threadId is required' });
  }

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  // One active run per thread
  if (runManager.hasActiveRun(threadId)) {
    return res.status(409).json({
      error: 'A run is already active for this thread',
    });
  }

  const useStreaming = streaming ?? true;
  const useModel = model ?? RESEARCH_MODE.model;

  if (messagesHaveImageParts(messages)) {
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
    messages,
    allowedTools,
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
    estimatedPromptTokens,
  });

  return res.json({ runId });
});

/**
 * POST /api/agent/context/estimate
 * Heuristic size of the next request envelope (same system + tools as /run).
 */
router.post('/context/estimate', async (req: Request, res: Response) => {
  const {
    messages,
    model,
    allowedTools,
    userPersona,
  } = req.body as Partial<StartRunRequest> & { messages?: ChatMessage[] };

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const useModel = model ?? RESEARCH_MODE.model;
  const { estimatedPromptTokens } = buildRunContext({
    messages,
    allowedTools,
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

/**
 * POST /api/agent/title
 * Enqueue a title generation job for a thread's first message.
 *
 * Body: { threadId: string; firstMessage: string }
 * Returns: { jobId: string }
 */
router.post('/title', async (req: Request, res: Response) => {
  const { threadId, firstMessage } = req.body;

  if (!threadId) {
    return res.status(400).json({ error: 'threadId is required' });
  }
  if (!firstMessage || typeof firstMessage !== 'string') {
    return res.status(400).json({ error: 'firstMessage is required' });
  }

  try {
    const job = await titleQueue.add('generate-title', {
      threadId,
      firstMessage,
    } satisfies TitleJobData);
    return res.json({ jobId: job.id ?? '' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: `Failed to enqueue: ${msg}` });
  }
});

/**
 * GET /api/agent/title/:jobId
 * Poll a title generation job's result.
 *
 * Returns:
 *   200 { status: 'completed', title: string }
 *   200 { status: 'pending' }
 *   200 { status: 'failed', error: string }
 *   404 { error: 'Job not found' }
 */
router.get('/title/:jobId', async (req: Request, res: Response) => {
  const { jobId } = req.params;

  const job = await titleQueue.getJob(jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (await job.isFailed()) {
    return res.json({ status: 'failed', error: 'Title generation failed' });
  }

  if (!job.returnvalue) {
    return res.json({ status: 'pending' });
  }

  const result = job.returnvalue as { title: string };
  return res.json({ status: 'completed', title: result.title });
});

/** True when any user message content array includes an image_url part. */
function messagesHaveImageParts(messages: unknown[]): boolean {
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part &&
        typeof part === 'object' &&
        (part as { type?: string }).type === 'image_url'
      ) {
        return true;
      }
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

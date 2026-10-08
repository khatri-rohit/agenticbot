import { Router, type Request, type Response } from 'express';
import {
  RunManager,
  createToolRegistry,
  allTools,
  getContext,
  createInvokeModelCall,
  createStreamModelCall,
  RESEARCH_MODE,
} from '@org/agent-core';
import { titleQueue, type TitleJobData } from '../../queue/title-queue';

const router = Router();
const runManager = new RunManager();

/**
 * POST /api/agent/run
 * Start a new agent run.
 *
 * Body: {
 *   threadId: string;
 *   messages: ChatMessage[];     // full context (server is stateless)
 *   streaming?: boolean;          // default: true
 *   model?: string;               // default: RESEARCH_MODE.model
 * }
 *
 * Returns: { runId: string }
 */
router.post('/run', (req: Request, res: Response) => {
  const { threadId, messages, streaming, model, allowedTools } = req.body;

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
  const clientTools = Array.isArray(allowedTools)
    ? allowedTools
    : RESEARCH_MODE.allowedTools;
  const toolAllowList = [
    ...new Set([...clientTools, ...RESEARCH_MODE.globalTools]),
  ];
  const tools = createToolRegistry(allTools, toolAllowList);

  // Build the OpenAI-format messages from the client's ChatMessage[]
  const openaiMessages = messages as any[];

  // Ensure system prompt is present
  const hasSystem = openaiMessages.some((m) => m.role === 'system');
  if (!hasSystem) {
    openaiMessages.unshift({
      role: 'system',
      content: getContext('', tools)[0].content,
    });
  }

  const modelCall = useStreaming
    ? createStreamModelCall()
    : createInvokeModelCall();

  const runId = runManager.start({
    threadId,
    model: useModel,
    streaming: useStreaming,
    messages: openaiMessages,
    tools,
    modelCall,
    limits: RESEARCH_MODE.limits,
  });

  return res.json({ runId });
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

export { router as agentRouter };

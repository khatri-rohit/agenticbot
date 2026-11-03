import { Router, type Request, type Response } from 'express';
import type {
  LedgerEnvelope,
  MessageAttachment,
  StartRunRequest,
} from '@agent/agent-models';
import {
  HOME_MODE,
  normalizeRunPosture,
  parseContextWindowMode,
  type RunPosture,
} from '@agent/agent-models';

import { getThreadStore, runManager } from '../platform/instances';
import {
  endpointFromLocal,
  prepareRun,
  resolveRequestedSkills,
} from './run-context';
import { startThreadRun } from './start-run';

const router = Router();

/**
 * POST /api/agent/run
 * Append optional user turn to the host ledger, then start a run.
 */
router.post('/run', async (req: Request, res: Response) => {
  const result = await startThreadRun(req.body as StartRunRequest);
  if (result.ok) return res.json({ runId: result.runId });
  return res.status(REJECTION_STATUS[result.reason]).json({
    error: result.error,
    ...(result.runId !== undefined ? { runId: result.runId } : {}),
  });
});

const REJECTION_STATUS = { invalid: 400, not_found: 404, busy: 409 } as const;

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

import { Router, type Request, type Response } from 'express';
import type {
  AgentEvent,
  LedgerEnvelope,
  StartRunRequest,
} from '@agent/agent-models';
import {
  HOME_MODE,
  normalizeRunPosture,
  parseContextWindowMode,
  parseMessageAttachments,
  parseStartRunRequest,
  type RunPosture,
} from '@agent/agent-models';

import { getThreadStore, runManager } from '../platform/instances';
import { asyncRoute } from '../platform/http-errors';
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
router.post('/run', asyncRoute(async (req: Request, res: Response) => {
  const request = parseStartRunRequest(req.body);
  if (typeof request === 'string') return res.status(400).json({ error: request });
  const result = await startThreadRun(request);
  if (result.ok) return res.json({ runId: result.runId });
  return res.status(REJECTION_STATUS[result.reason]).json({
    error: result.error,
    ...(result.runId !== undefined ? { runId: result.runId } : {}),
  });
}));

const REJECTION_STATUS = { invalid: 400, not_found: 404, busy: 409 } as const;

/**
 * POST /api/agent/context/estimate
 * Same assembler as /run: host ledger + memory files + optional draft.
 */
router.post('/context/estimate', asyncRoute(async (req: Request, res: Response) => {
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
    attachments?: unknown;
    model?: string;
    webSearch?: boolean;
    local?: boolean;
    posture?: RunPosture;
    skills?: StartRunRequest['skills'];
    contextWindowMode?: unknown;
  };
  const previewWindowMode = parseContextWindowMode(contextWindowMode);
  const parsedAttachments = parseMessageAttachments(attachments);
  if (typeof parsedAttachments === 'string') {
    return res.status(400).json({ error: parsedAttachments });
  }

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
  if (trimmed || parsedAttachments.length > 0) {
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
        ...(parsedAttachments.length > 0
          ? { attachments: parsedAttachments }
          : {}),
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
}));

/**
 * POST /api/agent/run/:runId/cancel
 * Stop an in-flight run. `finishing`: the answer is already saved and only
 * post-run work is left, so nothing is cancelled; wait for run.settled.
 */
router.post('/run/:runId/cancel', (req: Request, res: Response) => {
  const result = runManager.cancel(req.params.runId);
  if (result === 'not_found') {
    return res.status(404).json({ error: 'Run not found or not active' });
  }
  return res.json({ ok: true, ...(result === 'finishing' ? { finishing: true } : {}) });
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
 * SSE stream of AgentEvents for a run: replays buffered events after fromSeq,
 * then streams live ones. The response ends with run.settled, or with
 * `event: done` for a run already settled.
 */
router.get('/run/:runId/events', (req: Request, res: Response) => {
  const fromSeq = Number(req.query.fromSeq ?? 0);
  let ended = false;
  const send = (event: AgentEvent) => {
    if (ended) return;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'run.settled') end();
  };
  const subscription = runManager.subscribe(req.params.runId, fromSeq, send);
  if (!subscription) {
    return res.status(404).json({ error: 'Run not found' });
  }
  function end() {
    if (ended) return;
    ended = true;
    subscription?.unsubscribe();
    res.end();
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Flush headers immediately.
  res.write(': connected\n\n');
  for (const event of subscription.replay) send(event);
  if (!subscription.live) {
    if (!ended) res.write('event: done\ndata: {}\n\n');
    end();
    return;
  }
  req.on('close', end);
  return;
});

export { router as runsRouter };

import { Router, type Request, type Response } from 'express';
import { DEFAULT_MEMORY_CAPS, isWorkspaceKind, revertedOpId } from '@agent/agent-models';
import { getMemoryStore, getThreadStore } from '../platform/instances';
import { asyncRoute } from '../platform/http-errors';

const router = Router();

router.get('/memory', asyncRoute(async (req: Request, res: Response) => {
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
  const reverted = new Set(ops.map(revertedOpId).filter(Boolean));
  // Reverts and the entries they undo both leave the list.
  const visible = ops.filter(
    (op) =>
      op.status === 'applied' && !revertedOpId(op) && !reverted.has(op.id),
  );
  return res.json({ files, ops: visible, caps: DEFAULT_MEMORY_CAPS });
}));

router.patch('/memory', asyncRoute(async (req: Request, res: Response) => {
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
}));

router.post('/memory/revert', asyncRoute(async (req: Request, res: Response) => {
  const opId = typeof req.body?.opId === 'string' ? req.body.opId.trim() : '';
  if (!opId) return res.status(400).json({ error: 'opId is required' });
  try {
    const op = await getMemoryStore().revert(opId);
    return res.json({ op });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return res.status(400).json({ error: msg });
  }
}));

/** Suggestions waiting for the user (learning loop, staged foreground writes). */
router.get('/memory/pending', asyncRoute(async (_req: Request, res: Response) => {
  return res.json({ ops: await getMemoryStore().listPending() });
}));

/** Approve or reject one pending suggestion. Notes go to the folder of the thread that proposed them. */
router.post('/memory/pending/:opId', asyncRoute(async (req: Request, res: Response) => {
  const decision = req.body?.decision;
  if (decision !== 'approve' && decision !== 'reject') {
    return res.status(400).json({ error: 'decision must be approve or reject' });
  }
  const memory = getMemoryStore();
  const op = (await memory.listPending()).find((item) => item.id === req.params.opId);
  if (!op) return res.status(404).json({ error: 'Pending suggestion not found' });
  const thread = (await getThreadStore()).getThread(op.source.threadId);
  const workspaceRoot =
    op.target === 'notes' && thread && isWorkspaceKind(thread.kind)
      ? thread.workspaceRoot
      : undefined;
  try {
    const resolved = await memory.resolveStaged(op.id, decision, workspaceRoot);
    return res.json({ op: resolved });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return res.status(400).json({ error: msg });
  }
}));

export { router as memoryRouter };

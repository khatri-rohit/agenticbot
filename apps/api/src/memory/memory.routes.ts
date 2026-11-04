import { Router, type Request, type Response } from 'express';
import { DEFAULT_MEMORY_CAPS } from '@agent/agent-models';
import { getMemoryStore } from '../platform/instances';
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

export { router as memoryRouter };

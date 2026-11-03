import { Router, type Request, type Response } from 'express';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ThreadKind } from '@agent/agent-models';
import {
  HOME_MODE,
  isWorkspaceKind,
  parseContextWindowMode,
  parseThreadKind,
} from '@agent/agent-models';
import { getThreadStore, runManager } from '../platform/instances';
import { pickFolderDialog } from './pick-folder';

const router = Router();

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
  const includeSubagents = req.query.includeSubagents === 'true';
  return res.json({
    threads: store.listThreads({
      ...(kind ? { kind } : {}),
      ...(workspaceRoot ? { workspaceRoot } : {}),
      ...(includeSubagents ? { includeSubagents: true } : {}),
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
    contextWindowMode?: unknown;
  };
  const contextWindowMode = parseContextWindowMode(body.contextWindowMode);
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
    ...(contextWindowMode ? { contextWindowMode } : {}),
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

export { router as threadsRouter };

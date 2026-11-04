import { Router, type Request, type Response } from 'express';
import { listSkillCatalogs } from '@agent/agent-core';

import { getAgentHome } from '../platform/instances';
import { asyncRoute } from '../platform/http-errors';
import {
  SkillImportError,
  deleteUserSkill,
  installGitHubSkills,
  previewGitHubSkills,
} from './user-skills';

const router = Router();

function fail(res: Response, error: unknown): void {
  if (error instanceof SkillImportError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  res.status(500).json({
    error: error instanceof Error ? error.message : 'Skill request failed',
  });
}

router.get('/skills', (_req: Request, res: Response) => {
  try {
    getAgentHome();
    res.json(listSkillCatalogs());
  } catch (error) {
    fail(res, error);
  }
});

router.post('/skills/preview', asyncRoute(async (req: Request, res: Response) => {
  try {
    res.json(await previewGitHubSkills(String(req.body?.repoUrl ?? '')));
  } catch (error) {
    fail(res, error);
  }
}));

router.post('/skills/install', asyncRoute(async (req: Request, res: Response) => {
  try {
    const skills = Array.isArray(req.body?.skills) ? req.body.skills : [];
    await installGitHubSkills({
      agentHome: getAgentHome(),
      repoUrl: String(req.body?.repoUrl ?? ''),
      commit: String(req.body?.commit ?? ''),
      skills: skills.map(
        (skill: { pathInRepo?: string; folderName?: string }) => ({
          pathInRepo: String(skill.pathInRepo ?? ''),
          folderName: String(skill.folderName ?? ''),
        }),
      ),
    });
    res.json(listSkillCatalogs());
  } catch (error) {
    fail(res, error);
  }
}));

router.delete('/skills/:folder', asyncRoute(async (req: Request, res: Response) => {
  try {
    await deleteUserSkill(getAgentHome(), String(req.params.folder ?? ''));
    res.json(listSkillCatalogs());
  } catch (error) {
    fail(res, error);
  }
}));

export { router as skillsRouter };

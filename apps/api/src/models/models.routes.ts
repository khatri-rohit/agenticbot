import { Router, type Request, type Response } from 'express';
import type { OllamaEndpoint } from '@agent/agent-models';
import { getOllamaModelConfig, listOllamaModels } from '@agent/agent-core';
import { BalanceError, capacityEnabled, getOllamaBalance } from './capacity';
import { system1AutoFor } from '../runs/system1-runtime';
import { asyncRoute } from '../platform/http-errors';

const router = Router();

router.get('/usage/balance', asyncRoute(async (_req: Request, res: Response) => {
  if (!capacityEnabled()) {
    res.status(404).json({ error: 'No OLLAMA_API_KEY configured' });
    return;
  }

  try {
    res.json(await getOllamaBalance());
  } catch (error) {
    if (error instanceof BalanceError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    res.status(502).json({
      error: error instanceof Error ? error.message : 'Balance fetch failed',
    });
  }
}));

/** Returns null when the query is present but not a known endpoint. */
function parseEndpointQuery(
  value: unknown,
  fallback: OllamaEndpoint,
): OllamaEndpoint | null {
  if (value === undefined || value === '') return fallback;
  if (value === 'cloud' || value === 'local') return value;
  return null;
}

/**
 * GET /api/agent/models/config?model=&endpoint=local|cloud
 * Proxy for Ollama /api/show (context length, thinking values).
 * Registered before /models so a future /models/:id never shadows this path.
 */
router.get('/models/config', asyncRoute(async (req: Request, res: Response) => {
  const model =
    typeof req.query.model === 'string' ? req.query.model.trim() : '';
  if (!model) {
    return res.status(400).json({ error: 'model is required' });
  }
  // Default cloud when omitted (backward compatible with existing clients).
  const endpoint = parseEndpointQuery(req.query.endpoint, 'cloud');
  if (!endpoint) {
    return res
      .status(400)
      .json({ error: 'endpoint must be "local" or "cloud"' });
  }

  try {
    const config = await getOllamaModelConfig(model, endpoint);
    return res.json({
      ...config,
      system1Auto: system1AutoFor(endpoint, config),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(502).json({ error: msg });
  }
}));

/**
 * GET /api/agent/models?endpoint=local|cloud
 * Proxy for Ollama GET /api/tags (installed models). Defaults to local.
 */
router.get('/models', asyncRoute(async (req: Request, res: Response) => {
  const endpoint = parseEndpointQuery(req.query.endpoint, 'local');
  if (!endpoint) {
    return res
      .status(400)
      .json({ error: 'endpoint must be "local" or "cloud"' });
  }
  try {
    const models = await listOllamaModels(endpoint);
    return res.json({ endpoint, models });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(502).json({ error: msg });
  }
}));

export { router as modelsRouter };

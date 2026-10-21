/**
 * Ollama native APIs: POST /api/show (capabilities) and GET /api/tags (installed models).
 * Chat still uses the OpenAI-compatible /v1 client.
 */

import type {
  OllamaEndpoint,
  OllamaListedModel,
  OllamaModelConfig,
  OllamaThinkingConfig,
  ThinkingMode,
  ThinkingValue,
} from '@desk/agent-models';

import { nativeOllamaBaseUrl } from './client';

type ShowResponse = {
  error?: string;
  capabilities?: string[];
  thinking?: { values?: ThinkingValue[]; default?: ThinkingValue };
  model_info?: Record<string, unknown>;
};

type TagsResponse = {
  models?: Array<{
    name?: string;
    model?: string;
    size?: number;
    modified_at?: string;
    details?: { family?: string };
  }>;
  error?: string;
};

const configCache = new Map<string, OllamaModelConfig>();

function authHeaders(): Record<string, string> {
  if (!process.env.OLLAMA_API_KEY) return {};
  return { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` };
}

function contextLength(
  modelInfo: Record<string, unknown> | undefined,
): number | null {
  if (!modelInfo) return null;
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith('.context_length') && typeof value === 'number') {
      return value;
    }
  }
  return null;
}

function classifyThinking(
  thinking?: ShowResponse['thinking'],
): OllamaThinkingConfig {
  const values = thinking?.values ?? [];
  const fallback = thinking?.default ?? null;

  if (values.length === 0 || (values.length === 1 && values[0] === false)) {
    return {
      supported: false,
      values,
      default: fallback,
      mode: 'none',
    };
  }

  const hasBool = values.some((v) => typeof v === 'boolean');
  const hasStr = values.some((v) => typeof v === 'string');
  const mode: ThinkingMode =
    hasBool && hasStr ? 'mixed' : hasStr ? 'levels' : 'boolean';

  return {
    supported: true,
    values,
    default: fallback,
    mode,
  };
}

/** Map UI/API thinking choice → OpenAI-compat `reasoning_effort`. */
export function resolveReasoningEffort(
  cfg: OllamaModelConfig,
  requested: ThinkingValue | undefined,
): string | undefined {
  if (!cfg.thinking.supported) return undefined;

  const req = requested ?? cfg.thinking.default;
  if (req === undefined || req === null) return undefined;

  const off = req === false || req === 'none';
  if (cfg.thinking.mode === 'boolean') {
    return off ? 'none' : 'medium';
  }
  if (off) {
    return cfg.thinking.values.includes(false) ? 'none' : undefined;
  }
  if (req === true) {
    const def = cfg.thinking.default;
    return typeof def === 'string' ? def : 'medium';
  }

  const asStr = String(req);
  if (cfg.thinking.values.includes(asStr)) return asStr;
  return typeof cfg.thinking.default === 'string'
    ? cfg.thinking.default
    : undefined;
}

function cacheKey(endpoint: OllamaEndpoint, model: string): string {
  return `${endpoint}:${model}`;
}

export async function getOllamaModelConfig(
  model: string,
  endpoint: OllamaEndpoint = 'cloud',
): Promise<OllamaModelConfig> {
  const key = cacheKey(endpoint, model);
  const hit = configCache.get(key);
  if (hit) return hit;

  const res = await fetch(`${nativeOllamaBaseUrl(endpoint)}/api/show`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({ model }),
    signal: AbortSignal.timeout(15_000),
  });

  const data = (await res.json().catch(() => ({}))) as ShowResponse;
  if (!res.ok) {
    throw new Error(
      `show failed: ${res.status} ${data.error ?? JSON.stringify(data)}`,
    );
  }
  if (data.error) throw new Error(data.error);

  const capabilities = data.capabilities ?? [];
  const config: OllamaModelConfig = {
    model,
    capabilities,
    contextLength: contextLength(data.model_info),
    thinking: classifyThinking(data.thinking),
    supportsTools: capabilities.includes('tools'),
    supportsVision: capabilities.includes('vision'),
  };
  configCache.set(key, config);
  return config;
}

/** List models installed on the Ollama daemon (GET /api/tags). */
export async function listOllamaModels(
  endpoint: OllamaEndpoint = 'local',
): Promise<OllamaListedModel[]> {
  const res = await fetch(`${nativeOllamaBaseUrl(endpoint)}/api/tags`, {
    headers: { ...authHeaders() },
    signal: AbortSignal.timeout(10_000),
  });

  const data = (await res.json().catch(() => ({}))) as TagsResponse;
  if (!res.ok) {
    throw new Error(
      `tags failed: ${res.status} ${data.error ?? JSON.stringify(data)}`,
    );
  }
  if (data.error) throw new Error(data.error);

  const models: OllamaListedModel[] = [];
  for (const row of data.models ?? []) {
    const id = (row.name ?? row.model ?? '').trim();
    if (!id) continue;
    models.push({
      id,
      size: typeof row.size === 'number' ? row.size : null,
      modifiedAt: typeof row.modified_at === 'string' ? row.modified_at : null,
      family:
        typeof row.details?.family === 'string' ? row.details.family : null,
    });
  }
  return models;
}

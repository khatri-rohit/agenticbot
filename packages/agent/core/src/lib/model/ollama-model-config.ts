/**
 * Ollama POST /api/show → context length + thinking values.
 * Chat still uses the OpenAI-compatible /v1 client.
 */

import type {
  OllamaModelConfig,
  OllamaThinkingConfig,
  ThinkingMode,
  ThinkingValue,
} from '@org/agent-models';

type ShowResponse = {
  error?: string;
  capabilities?: string[];
  thinking?: { values?: ThinkingValue[]; default?: ThinkingValue };
  model_info?: Record<string, unknown>;
};

const cache = new Map<string, OllamaModelConfig>();

function nativeBaseUrl(): string {
  const base = process.env.OLLAMA_BASE_URL ?? 'https://ollama.com/v1';
  return base.replace(/\/v1\/?$/, '').replace(/\/$/, '');
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

export async function getOllamaModelConfig(
  model: string,
): Promise<OllamaModelConfig> {
  const hit = cache.get(model);
  if (hit) return hit;

  const res = await fetch(`${nativeBaseUrl()}/api/show`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.OLLAMA_API_KEY
        ? { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` }
        : {}),
    },
    body: JSON.stringify({ model }),
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
  cache.set(model, config);
  return config;
}

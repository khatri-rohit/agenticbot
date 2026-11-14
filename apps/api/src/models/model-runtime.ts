import {
  contextBudgetForWindow,
  resolveContextWindow,
  resolveModelRoles,
  type ContextBudget,
  type ContextWindowMode,
  type ContextWindowSource,
  type ModelRoles,
  type OllamaEndpoint,
  type ThinkingValue,
} from '@agent/agent-models';
import {
  getOllamaModelConfig,
  getServedContextLength,
  resolveReasoningEffort,
} from '@agent/agent-core';

/** Per-model call knobs: thinking effort from /api/show, endpoint, temperature. */
export async function resolveCallOptions(
  model: string,
  thinking: unknown,
  endpoint: OllamaEndpoint,
  temperature: number,
): Promise<{
  reasoningEffort?: string;
  endpoint: OllamaEndpoint;
  temperature: number;
}> {
  const requested: ThinkingValue | undefined =
    typeof thinking === 'boolean' ||
    (typeof thinking === 'string' && thinking.length > 0)
      ? thinking
      : undefined;

  try {
    const config = await getOllamaModelConfig(model, endpoint);
    const reasoningEffort = resolveReasoningEffort(config, requested);
    return {
      endpoint,
      temperature,
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    };
  } catch {
    // /api/show unavailable — omit effort; still route to the chosen endpoint
    return { endpoint, temperature };
  }
}

/**
 * Context budget for a model under a window mode: 260k by default (or the
 * model's size when smaller), the model's full size in `model` mode, 260k
 * when /api/show fails. On the local daemon the window is also capped by the
 * context the model is loaded with (/api/ps): chat goes through /v1, which
 * cannot request a size, so a longer prompt would be cut from the front.
 * A model that is not loaded yet reports nothing; the next run sees it.
 */
export async function resolveContextBudget(
  model: string,
  endpoint: OllamaEndpoint,
  mode?: ContextWindowMode,
): Promise<{ budget: ContextBudget; source: ContextWindowSource; modelMax: number | null }> {
  let modelMax: number | null = null;
  try {
    const config = await getOllamaModelConfig(model, endpoint);
    modelMax = config.contextLength ?? null;
  } catch {
    // Keep the fallback window when /api/show is unavailable.
  }
  const servedMax =
    endpoint === 'local' ? await getServedContextLength(model, endpoint) : null;
  const window = resolveContextWindow({
    ...(mode ? { mode } : {}),
    modelMax,
    servedMax,
  });
  return { budget: contextBudgetForWindow(window.windowTokens), source: window.source, modelMax };
}

/** Sub-agent model roles. AGENT_MODEL_FAST / AGENT_MODEL_STRONG default to the parent's model. */
export function modelRolesFor(main: string): ModelRoles {
  return resolveModelRoles({
    main,
    ...(process.env.AGENT_MODEL_FAST ? { fast: process.env.AGENT_MODEL_FAST } : {}),
    ...(process.env.AGENT_MODEL_STRONG ? { strong: process.env.AGENT_MODEL_STRONG } : {}),
  });
}

/**
 * Boot check: a sub-agent role model without tool support would fail mid-run.
 * Warns once per configured role; never blocks startup.
 */
export async function warnRoleModelsWithoutTools(): Promise<void> {
  const roles = [
    ['AGENT_MODEL_FAST', process.env.AGENT_MODEL_FAST?.trim()],
    ['AGENT_MODEL_STRONG', process.env.AGENT_MODEL_STRONG?.trim()],
  ] as const;
  for (const [name, model] of roles) {
    if (!model) continue;
    try {
      const config = await getOllamaModelConfig(model, 'cloud');
      if (!config.supportsTools) {
        console.warn(`[models] ${name}=${model} does not list the "tools" capability; sub-agents on it cannot call tools`);
      }
    } catch (error) {
      console.warn(`[models] ${name}=${model}: /api/show failed (${error instanceof Error ? error.message : error})`);
    }
  }
}

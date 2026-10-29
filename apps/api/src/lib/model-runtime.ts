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
import { getOllamaModelConfig, resolveReasoningEffort } from '@agent/agent-core';

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
 * Context budget for a model under a window mode: 200k by default (or the
 * model's size when smaller), the model's full size in `model` mode, 200k
 * when /api/show fails.
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
  const window = resolveContextWindow({ ...(mode ? { mode } : {}), modelMax });
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

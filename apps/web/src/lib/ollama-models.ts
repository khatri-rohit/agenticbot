/**
 * Curated Ollama model catalog — cloud-hosted and local.
 * Cloud models use the `:cloud` tag (Ollama Cloud API).
 * Local models use size tags (user must `ollama pull` first).
 *
 * Capability flags follow each model's Ollama library page.
 * @see https://ollama.com/search?c=cloud
 */

export type OllamaModel = {
  id: string;
  label: string;
  family: string;
  /** Cloud-hosted via Ollama Cloud API (`:cloud` suffix). */
  cloud: boolean;
  /** Supports image (and/or video) input in chat. */
  vision: boolean;
  /** Supports reasoning / thinking mode. */
  thinking: boolean;
  /** Supports tool / function calling. */
  tools: boolean;
  /** Max context window in tokens, if known. */
  contextLength: number | null;
  hint?: string;
};

const DEFAULT_OLLAMA_MODEL = 'glm-5.2:cloud';

export const OLLAMA_MODELS: OllamaModel[] = [
  // ── Cloud: GLM ──
  {
    id: 'glm-5.3:cloud',
    label: 'GLM 5.3',
    family: 'GLM',
    cloud: true,
    vision: false,
    thinking: true,
    tools: true,
    contextLength: 1_000_000,
    hint: 'Flagship coding & agents',
  },
  {
    id: 'glm-5.3-flash:cloud',
    label: 'GLM 5.3 Flash',
    family: 'GLM',
    cloud: true,
    vision: true,
    thinking: true,
    tools: true,
    contextLength: 1_000_000,
    hint: 'Fast multimodal (image/video)',
  },
  {
    id: 'glm-5.2:cloud',
    label: 'GLM 5.2',
    family: 'GLM',
    cloud: true,
    vision: false,
    thinking: true,
    tools: true,
    contextLength: 1_000_000,
    hint: 'Default research model',
  },

  // ── Cloud: DeepSeek ──
  {
    id: 'deepseek-v4.1-flash:cloud',
    label: 'DeepSeek V4.1 Flash',
    family: 'DeepSeek',
    cloud: true,
    vision: true,
    thinking: true,
    tools: true,
    contextLength: 1_000_000,
    hint: 'Fast search & reasoning',
  },
  {
    id: 'deepseek-v4-pro:cloud',
    label: 'DeepSeek V4 Pro',
    family: 'DeepSeek',
    cloud: true,
    vision: false,
    thinking: true,
    tools: true,
    contextLength: 1_000_000,
    hint: 'Frontier MoE, 3 reasoning modes',
  },

  // ── Cloud: Mistral ──
  {
    id: 'mistral-large-4:cloud',
    label: 'Mistral Large 4',
    family: 'Mistral',
    cloud: true,
    vision: true,
    thinking: true,
    tools: true,
    contextLength: 1_000_000,
    hint: 'Multimodal MoE, 1T params',
  },
  {
    id: 'mistral-large-3:cloud',
    label: 'Mistral Large 3',
    family: 'Mistral',
    cloud: true,
    vision: true,
    thinking: false,
    tools: true,
    contextLength: 256_000,
    hint: 'Enterprise multimodal',
  },

  // ── Cloud: MiniMax ──
  {
    id: 'minimax-m3:cloud',
    label: 'MiniMax M3',
    family: 'MiniMax',
    cloud: true,
    vision: true,
    thinking: true,
    tools: true,
    contextLength: 500_000,
    hint: '1M context, native multimodality',
  },
  {
    id: 'minimax-m2.7:cloud',
    label: 'MiniMax M2.7',
    family: 'MiniMax',
    cloud: true,
    vision: false,
    thinking: true,
    tools: true,
    contextLength: 192_000,
    hint: 'Coding & productivity',
  },

  // ── Cloud: Kimi ──
  {
    id: 'kimi-k3:cloud',
    label: 'Kimi K3',
    family: 'Kimi',
    cloud: true,
    vision: true,
    thinking: true,
    tools: true,
    contextLength: 1_000_000,
    hint: 'Most capable Kimi model',
  },
  {
    id: 'kimi-k2.7-code:cloud',
    label: 'Kimi K2.7 Code',
    family: 'Kimi',
    cloud: true,
    vision: true,
    thinking: true,
    tools: true,
    contextLength: 256_000,
    hint: 'Coding-focused, lower thinking tokens',
  },
  {
    id: 'kimi-k2.6:cloud',
    label: 'Kimi K2.6',
    family: 'Kimi',
    cloud: true,
    vision: true,
    thinking: true,
    tools: true,
    contextLength: 256_000,
    hint: 'Agentic coding & design',
  },

  // ── Cloud: Gemma ──
  {
    id: 'gemma4:cloud',
    label: 'Gemma 4',
    family: 'Gemma',
    cloud: true,
    vision: true,
    thinking: true,
    tools: true,
    contextLength: 256_000,
    hint: 'Google multimodal',
  },

  // ── Cloud: NVIDIA ──
  {
    id: 'nemotron-3-ultra:cloud',
    label: 'Nemotron 3 Ultra',
    family: 'NVIDIA',
    cloud: true,
    vision: false,
    thinking: true,
    tools: true,
    contextLength: 256_000,
    hint: 'High-throughput reasoning',
  },
  {
    id: 'nemotron-3-super:cloud',
    label: 'Nemotron 3 Super',
    family: 'NVIDIA',
    cloud: true,
    vision: false,
    thinking: true,
    tools: true,
    contextLength: 256_000,
    hint: 'Efficient MoE for agents',
  },
  {
    id: 'nemotron-3-nano:cloud',
    label: 'Nemotron 3 Nano',
    family: 'NVIDIA',
    cloud: true,
    vision: false,
    thinking: true,
    tools: true,
    contextLength: 256_000,
    hint: 'Lightweight agentic',
  },

  // ── Cloud: OpenAI ──
  {
    id: 'gpt-oss:120b-cloud',
    label: 'GPT-OSS',
    family: 'OpenAI',
    cloud: true,
    vision: false,
    thinking: true,
    tools: true,
    contextLength: 128_000,
    hint: 'OpenAI open-weight reasoning',
  },

  // ── Local: Qwen ──
  {
    id: 'qwen3.8:27b',
    label: 'Qwen 3.8 27B',
    family: 'Qwen',
    cloud: false,
    vision: true,
    thinking: true,
    tools: true,
    contextLength: null,
    hint: 'Coding & agentic tasks',
  },
  {
    id: 'qwen3.6:27b',
    label: 'Qwen 3.6 27B',
    family: 'Qwen',
    cloud: false,
    vision: true,
    thinking: true,
    tools: true,
    contextLength: null,
    hint: 'Agentic coding & thinking',
  },
  {
    id: 'qwen3.8-flash-next',
    label: 'Qwen 3.8 Flash Next',
    family: 'Qwen',
    cloud: false,
    vision: true,
    thinking: true,
    tools: true,
    contextLength: null,
    hint: 'Qwen4 architecture preview',
  },

  // ── Local: Mistral ──
  {
    id: 'mistral-medium-3.5:128b',
    label: 'Mistral Medium 3.5 128B',
    family: 'Mistral',
    cloud: false,
    vision: true,
    thinking: true,
    tools: true,
    contextLength: null,
    hint: 'Instruction-following & coding',
  },

  // ── Local: Meta ──
  {
    id: 'muse-glimmer:30b',
    label: 'Muse Glimmer 30B',
    family: 'Meta',
    cloud: false,
    vision: true,
    thinking: true,
    tools: true,
    contextLength: null,
    hint: 'Always-on local agents',
  },
  {
    id: 'llama3.1:8b',
    label: 'Llama 3.1 8B',
    family: 'Meta',
    cloud: false,
    vision: false,
    thinking: false,
    tools: true,
    contextLength: 128_000,
    hint: 'Fast local general-purpose',
  },

  // ── Local: NVIDIA ──
  {
    id: 'nemotron3:33b',
    label: 'Nemotron 3 Nano Omni 33B',
    family: 'NVIDIA',
    cloud: false,
    vision: true,
    thinking: true,
    tools: true,
    contextLength: null,
    hint: 'Video, audio, image & text',
  },
  {
    id: 'nemotron-3.5-lightning:30b',
    label: 'Nemotron 3.5 Lightning 30B',
    family: 'NVIDIA',
    cloud: false,
    vision: false,
    thinking: true,
    tools: true,
    contextLength: null,
    hint: 'Efficient always-on agents',
  },

  // ── Local: IBM ──
  {
    id: 'granite4.1:8b',
    label: 'Granite 4.1 8B',
    family: 'IBM',
    cloud: false,
    vision: false,
    thinking: false,
    tools: true,
    contextLength: null,
    hint: 'Enterprise, RAG & JSON output',
  },
];

const MODEL_BY_ID = new Map(OLLAMA_MODELS.map((m) => [m.id, m]));

/** Curated cloud catalog only — local picker uses live `/api/tags`. */
export const CLOUD_OLLAMA_MODELS: OllamaModel[] = OLLAMA_MODELS.filter(
  (m) => m.cloud,
);

function getOllamaModel(id: string): OllamaModel | undefined {
  return MODEL_BY_ID.get(id);
}

/**
 * Prefer live Ollama /api/show when present; otherwise the catalog
 * `vision` flag so the composer can gate before config loads.
 */
export function modelSupportsVision(
  modelId: string,
  liveSupportsVision?: boolean | null,
): boolean {
  if (typeof liveSupportsVision === 'boolean') return liveSupportsVision;
  return getOllamaModel(modelId)?.vision ?? false;
}

export function resolveOllamaModel(id: string, local = false): string {
  const trimmed = id.trim();
  if (local) return trimmed;
  return MODEL_BY_ID.has(trimmed) ? trimmed : DEFAULT_OLLAMA_MODEL;
}

export function getOllamaModelLabel(id: string): string {
  return getOllamaModel(id)?.label ?? id;
}

/** Map a discovered local install into the picker row shape. */
export function listedModelToPickerModel(input: {
  id: string;
  family: string | null;
  size: number | null;
}): OllamaModel {
  const family = input.family?.trim() || 'Installed';
  return {
    id: input.id,
    label: input.id,
    family,
    cloud: false,
    vision: false,
    thinking: false,
    tools: false,
    contextLength: null,
    hint:
      input.size != null && input.size > 0
        ? formatModelSize(input.size)
        : undefined,
  };
}

function formatModelSize(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  if (gib >= 1) return `${gib.toFixed(1)} GB on disk`;
  const mib = bytes / 1024 ** 2;
  return `${Math.max(1, Math.round(mib))} MB on disk`;
}

const MODEL_STORAGE_KEY = 'agent:composerModel';
const LOCAL_MODEL_STORAGE_KEY = 'agent:composerLocalModel';
const LOCAL_MODE_KEY = 'agent:composerLocal';

export function readStoredComposerLocal(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(LOCAL_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeStoredComposerLocal(local: boolean): void {
  try {
    localStorage.setItem(LOCAL_MODE_KEY, local ? '1' : '0');
  } catch {
    /* ignore */
  }
}

export function readStoredComposerModel(local = false): string {
  if (typeof window === 'undefined') {
    return local ? '' : DEFAULT_OLLAMA_MODEL;
  }
  try {
    const key = local ? LOCAL_MODEL_STORAGE_KEY : MODEL_STORAGE_KEY;
    const raw = localStorage.getItem(key);
    if (local) return raw?.trim() ?? '';
    return raw ? resolveOllamaModel(raw) : DEFAULT_OLLAMA_MODEL;
  } catch {
    return local ? '' : DEFAULT_OLLAMA_MODEL;
  }
}

export function writeStoredComposerModel(model: string, local = false): void {
  try {
    const key = local ? LOCAL_MODEL_STORAGE_KEY : MODEL_STORAGE_KEY;
    const value = local ? model.trim() : resolveOllamaModel(model);
    if (!value) return;
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export { DEFAULT_OLLAMA_MODEL };

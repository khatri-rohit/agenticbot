/**
 * Curated Ollama Cloud models (CLI/API tags with :cloud suffix).
 * Vision flags follow each model's Ollama library readme (image/video input).
 * @see https://ollama.com/search?c=cloud
 */

export type OllamaCloudModel = {
  id: string;
  label: string;
  family: 'GLM' | 'Qwen' | 'Gemma' | 'Kimi';
  /** Supports image (and/or video) input in chat. */
  vision: boolean;
  hint?: string;
};

export const DEFAULT_OLLAMA_CLOUD_MODEL = 'glm-5.2:cloud';

export const OLLAMA_CLOUD_MODELS: OllamaCloudModel[] = [
  {
    id: 'glm-5.3:cloud',
    label: 'GLM 5.3',
    family: 'GLM',
    vision: false,
    hint: 'Flagship coding & agents',
  },
  {
    id: 'glm-5.3-flash:cloud',
    label: 'GLM 5.3 Flash',
    family: 'GLM',
    vision: true,
    hint: 'Fast multimodal (image/video)',
  },
  {
    id: 'glm-5.2:cloud',
    label: 'GLM 5.2',
    family: 'GLM',
    vision: false,
    hint: 'Default research model',
  },
  {
    id: 'qwen3.5:397b-cloud',
    label: 'Qwen 3.5 397B',
    family: 'Qwen',
    vision: false,
    hint: 'Reasoning & knowledge',
  },
  {
    id: 'qwen3-vl:235b-cloud',
    label: 'Qwen3-VL 235B',
    family: 'Qwen',
    vision: true,
    hint: 'Vision-language',
  },
  {
    id: 'gemma4:31b-cloud',
    label: 'Gemma 4 31B',
    family: 'Gemma',
    vision: true,
    hint: 'Google multimodal',
  },
  {
    id: 'kimi-k2.6:cloud',
    label: 'Kimi K2.6',
    family: 'Kimi',
    vision: true,
    hint: 'Agentic coding & design',
  },
  {
    id: 'kimi-k3:cloud',
    label: 'Kimi K3',
    family: 'Kimi',
    vision: true,
    hint: '1M context multimodal',
  },
];

const MODEL_BY_ID = new Map(OLLAMA_CLOUD_MODELS.map((m) => [m.id, m]));

export function getOllamaCloudModel(id: string): OllamaCloudModel | undefined {
  return MODEL_BY_ID.get(id);
}

export function resolveOllamaCloudModel(id: string): string {
  return MODEL_BY_ID.has(id) ? id : DEFAULT_OLLAMA_CLOUD_MODEL;
}

export function getOllamaCloudModelLabel(id: string): string {
  return getOllamaCloudModel(id)?.label ?? id;
}

const MODEL_STORAGE_KEY = 'agenticbot:composerModel';

export function readStoredComposerModel(): string {
  if (typeof window === 'undefined') return DEFAULT_OLLAMA_CLOUD_MODEL;
  try {
    const raw = localStorage.getItem(MODEL_STORAGE_KEY);
    return raw ? resolveOllamaCloudModel(raw) : DEFAULT_OLLAMA_CLOUD_MODEL;
  } catch {
    return DEFAULT_OLLAMA_CLOUD_MODEL;
  }
}

export function writeStoredComposerModel(model: string): void {
  try {
    localStorage.setItem(MODEL_STORAGE_KEY, resolveOllamaCloudModel(model));
  } catch {
    /* ignore */
  }
}

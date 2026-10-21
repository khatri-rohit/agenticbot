import { OpenAI } from 'openai';
import type { OllamaEndpoint } from '@agenticbot/agent-models';

/**
 * OpenAI-compatible clients for Ollama cloud vs local daemon.
 * Lazy per-endpoint singletons so importing the package does not require env until first use.
 */
const DEFAULT_CLOUD_BASE_URL = 'https://ollama.com/v1';
const DEFAULT_LOCAL_BASE_URL = 'http://127.0.0.1:11434/v1';

const clients = new Map<OllamaEndpoint, OpenAI>();

export function resolveOllamaBaseUrl(
  endpoint: OllamaEndpoint = 'cloud',
): string {
  if (endpoint === 'local') {
    return process.env.OLLAMA_LOCAL_BASE_URL ?? DEFAULT_LOCAL_BASE_URL;
  }
  return process.env.OLLAMA_BASE_URL ?? DEFAULT_CLOUD_BASE_URL;
}

/** Strip OpenAI-compat `/v1` for native Ollama routes (`/api/tags`, `/api/show`). */
export function nativeOllamaBaseUrl(
  endpoint: OllamaEndpoint = 'cloud',
): string {
  return resolveOllamaBaseUrl(endpoint)
    .replace(/\/v1\/?$/, '')
    .replace(/\/$/, '');
}

export function getClient(endpoint: OllamaEndpoint = 'cloud'): OpenAI {
  const cached = clients.get(endpoint);
  if (cached) return cached;

  const baseURL = resolveOllamaBaseUrl(endpoint);
  const usingCloudDefault =
    endpoint === 'cloud' && baseURL === DEFAULT_CLOUD_BASE_URL;

  if (usingCloudDefault && !process.env.OLLAMA_API_KEY) {
    throw new Error(
      'OLLAMA_API_KEY is required when using the default Ollama cloud base URL. Set OLLAMA_API_KEY, or set OLLAMA_BASE_URL for local/custom Ollama.',
    );
  }

  const client = new OpenAI({
    baseURL,
    apiKey: process.env.OLLAMA_API_KEY ?? 'ollama',
  });
  clients.set(endpoint, client);
  return client;
}

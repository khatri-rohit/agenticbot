import { OpenAI } from 'openai';

/**
 * OpenAI-compatible client for Ollama. Defaults to cloud (`https://ollama.com/v1`).
 * Lazy singleton so importing the package does not require env until first use.
 */
const DEFAULT_CLOUD_BASE_URL = 'https://ollama.com/v1';

let cached: OpenAI | undefined;

export function getClient(): OpenAI {
  if (cached) return cached;

  const baseURL = process.env.OLLAMA_BASE_URL ?? DEFAULT_CLOUD_BASE_URL;
  const usingCloudDefault = baseURL === DEFAULT_CLOUD_BASE_URL;

  if (usingCloudDefault && !process.env.OLLAMA_API_KEY) {
    throw new Error(
      'OLLAMA_API_KEY is required when using the default Ollama cloud base URL. Set OLLAMA_API_KEY, or set OLLAMA_BASE_URL for local/custom Ollama.',
    );
  }

  cached = new OpenAI({
    baseURL,
    apiKey: process.env.OLLAMA_API_KEY ?? 'ollama',
  });
  return cached;
}

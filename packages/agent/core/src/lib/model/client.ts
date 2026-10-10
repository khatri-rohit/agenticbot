import { OpenAI } from 'openai';

/**
 * Single OpenAI-compatible client. Defaults to cloud Ollama (`https://ollama.com/v1`).
 *
 * Kept as a module-level singleton so the HTTP keep-alive pool is shared.
 * Override via `OLLAMA_BASE_URL` / `OLLAMA_API_KEY` for local Ollama or other providers.
 */
const DEFAULT_CLOUD_BASE_URL = 'https://ollama.com/v1';
const baseURL = process.env.OLLAMA_BASE_URL ?? DEFAULT_CLOUD_BASE_URL;
const usingCloudDefault = baseURL === DEFAULT_CLOUD_BASE_URL;

if (usingCloudDefault && !process.env.OLLAMA_API_KEY) {
  throw new Error(
    'OLLAMA_API_KEY is required when using the default Ollama cloud base URL. Set OLLAMA_API_KEY, or set OLLAMA_BASE_URL for local/custom Ollama.',
  );
}

export const client = new OpenAI({
  baseURL,
  apiKey: process.env.OLLAMA_API_KEY ?? 'ollama',
});

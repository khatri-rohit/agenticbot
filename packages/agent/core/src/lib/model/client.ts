import { OpenAI } from 'openai';

/**
 * Single OpenAI-compatible client. Defaults to cloud Ollama (`https://ollama.com/v1`).
 *
 * Kept as a module-level singleton so the HTTP keep-alive pool is shared.
 * Override via `OLLAMA_BASE_URL` / `OLLAMA_API_KEY` for local Ollama or other providers.
 */
export const client = new OpenAI({
  baseURL: process.env.OLLAMA_BASE_URL ?? 'https://ollama.com/v1',
  apiKey: process.env.OLLAMA_API_KEY ?? 'ollama',
});

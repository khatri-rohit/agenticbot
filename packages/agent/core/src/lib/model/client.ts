import { OpenAI } from 'openai';

/**
 * Single OpenAI-compatible client. Points at a local Ollama server by default.
 *
 * Kept as a module-level singleton so the HTTP keep-alive pool is shared.
 * Override base URL / API key via env for cloud Ollama or other OpenAI-compatible providers.
 */
export const client = new OpenAI({
  baseURL: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434/v1',
  apiKey: process.env.OLLAMA_API_KEY ?? 'ollama',
});
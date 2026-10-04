import { OpenAI } from 'openai';

export const client = new OpenAI({
  // baseURL: 'http://localhost:11434/v1',
  baseURL: 'https://ollama.com/v1',
  apiKey: process.env.OLLAMA_API_KEY ?? 'ollama',
});

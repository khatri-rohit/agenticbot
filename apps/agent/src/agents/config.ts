import { OpenAI } from 'openai';
import { setDefaultOpenAIClient } from '@openai/agents';

const customClient = new OpenAI({
  baseURL: 'http://localhost:11434/v1',
  // ponytail: Ollama ignores the key; OpenAI SDK still requires a non-empty string
  apiKey: process.env.OPENAI_API_KEY ?? 'ollama',
});
setDefaultOpenAIClient(customClient);

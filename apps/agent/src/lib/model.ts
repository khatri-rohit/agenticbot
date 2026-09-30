import { ChatOllama } from '@langchain/ollama';

export const getAgentModel = (model = 'glm-5.2:cloud') => {
  return new ChatOllama({
    model: model,
    baseUrl: 'https://ollama.com',
    temperature: 0.7,
    headers: {
      Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
    },
  });
};

import { runAgent } from './agents/agent';
import { getContext } from './agents/libs/context';
import { createTools } from './agents/tools';

// const MODEL = 'llama3.2:3b';
const MODEL = 'glm-5.2:cloud';
// const MODEL = 'llama3.1:8b';

async function main() {
  try {
    // const query = 'Hi, how are you?';
    // const query = 'What is the capital of France?';
    // const query = 'What is the latest news about OpenAI?';
    const query =
      'Search the web and tell me what the latest React release is.';

    const tools = createTools();
    const messages = getContext(query);

    const result = await runAgent(MODEL, messages, tools, {
      limits: {
        maxIterations: 8,
        maxToolCalls: 12,
        maxRepeatedToolCalls: 2,
        toolTimeoutMs: 30_000,
      },
    });

    console.log('================================================');
    console.log('Model:', MODEL);
    console.log('Result:', result);
    console.log('================================================');
  } catch (error) {
    console.error('Something went wrong:', error);
  }
}

main();

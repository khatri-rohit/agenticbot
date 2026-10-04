import { runAgent } from './agents/agent';
import { getContext } from './agents/libs/context';
import { createTools } from './agents/tools';

// const MODEL = 'llama3.2:3b';
// const MODEL = 'glm-5.2:cloud';
const MODEL = 'llama3.1:8b';

async function main() {
  try {
    const query = 'What are your capabilities?';
    const tools = createTools();
    const messages = getContext(query);
    const result = await runAgent(MODEL, messages, tools);

    console.log('Results: ', result);
  } catch (error) {
    console.error('Something went wrong: ');
    console.error(error);
  }
}

main();

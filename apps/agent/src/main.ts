import { runAgent } from './agents/agent';
import { getContext } from './agents/libs/context';
import { createTools } from './agents/tools';

const MODEL = 'llama3.2:3b';

async function main() {
  try {
    const tools = createTools();
    const messages = getContext('Why pandas are cute?');
    const result = await runAgent(MODEL, messages, tools);

    console.log('Result: ', result);
  } catch (error) {
    console.error('Something went wrong: ');
    console.error(error);
  }
}

main();

import { runAgent } from './agents/agent';

const MODEL = 'llama3.2:3b';

async function main() {
  try {
    const result = await runAgent(MODEL, [
      { role: 'user', content: 'Hello, how are you?' },
    ]);
    console.log('Result: ');
    console.log(result);
  } catch (error) {
    console.error('Something went wrong: ');
    console.error(error);
  }
}

main();

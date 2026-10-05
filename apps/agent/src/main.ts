import 'dotenv/config';

import {
  runLoop,
  invokeModelTurn,
  getContext,
  createToolRegistry,
  allTools,
  consoleTrace,
  RESEARCH_MODE,
} from '@org/agent-core';

const MODEL = RESEARCH_MODE.model;

async function main() {
  try {
    const query = 'What is value of PI in 3 decimal places?';
    // const query = 'What is the capital of France?';
    // const query = 'What is the latest news about OpenAI?';
    // const query =
    //   'Search the web and tell me what the latest React release is. And also tell me the latest news about OpenAI.';

    const tools = createToolRegistry(allTools, RESEARCH_MODE.allowedTools);
    const messages = getContext(query, tools);

    const result = await runLoop(invokeModelTurn, messages, tools, {
      model: MODEL,
      limits: RESEARCH_MODE.limits,
      trace: consoleTrace,
    });

    console.log('================================================');
    console.log('Model:', MODEL);
    console.log('Result:', result.content);
    console.log('Iterations:', result.iterations);
    console.log('Tool calls:', result.toolCalls);
    console.log('================================================');
  } catch (error) {
    console.error('Something went wrong:', error);
  }
}

main();
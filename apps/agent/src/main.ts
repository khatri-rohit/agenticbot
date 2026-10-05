import 'dotenv/config';

import {
  runLoop,
  invokeModelTurn,
  streamModelTurn,
  getContext,
  createToolRegistry,
  allTools,
  consoleTrace,
  RESEARCH_MODE,
} from '@org/agent-core';

const MODEL = RESEARCH_MODE.model;
// Set STREAMING=1 to use streaming mode
const STREAMING = process.env.STREAMING === '1';

async function main() {
  try {
    const query = 'What is value of PI in 3 decimal places?';
    // const query = 'What is the capital of France?';
    // const query = 'What is the latest news about OpenAI?';
    // const query =
    //   'Search the web and tell me what the latest React release is. And also tell me the latest news about OpenAI.';

    const tools = createToolRegistry(allTools, RESEARCH_MODE.allowedTools);
    const messages = getContext(query, tools);

    // Choose model call based on streaming flag.
    // Both produce the same ModelTurn — the loop doesn't know the difference.
    const modelCall = STREAMING
      ? (model: string, msgs: any, t: any) =>
          streamModelTurn(model, msgs, t, (delta) => {
            process.stdout.write(delta);
          })
      : invokeModelTurn;

    console.log(`Mode: ${STREAMING ? 'streaming' : 'non-streaming'}`);
    console.log('================================================');

    const result = await runLoop(modelCall, messages, tools, {
      model: MODEL,
      limits: RESEARCH_MODE.limits,
      trace: consoleTrace,
    });

    if (!STREAMING) {
      console.log('Result:', result.content);
    } else {
      console.log(''); // newline after streamed content
    }
    console.log('Iterations:', result.iterations);
    console.log('Tool calls:', result.toolCalls);
    console.log('================================================');
  } catch (error) {
    console.error('Something went wrong:', error);
  }
}

main();
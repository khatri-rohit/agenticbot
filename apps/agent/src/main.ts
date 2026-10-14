import 'dotenv/config';

import type { AgentEvent } from '@org/agent-models';
import {
  runLoop,
  invokeModelTurn,
  streamModelTurn,
  getContext,
  createToolRegistry,
  ALL_TOOLS,
  consoleTrace,
  type ModelCallFn,
  RESEARCH_MODE,
} from '@org/agent-core';

const MODEL = RESEARCH_MODE.model;
const STREAMING = process.env.STREAMING === '1';

async function main() {
  try {
    const query = 'What is value of PI in 3 decimal places?';

    const tools = createToolRegistry(ALL_TOOLS, [
      ...new Set([...RESEARCH_MODE.allowedTools, ...RESEARCH_MODE.globalTools]),
    ]);
    const messages = getContext(query, tools);

    // Collect events for display
    const events: AgentEvent[] = [];

    const modelCall: ModelCallFn = STREAMING
      ? (model, msgs, t, onDelta) => streamModelTurn(model, msgs, t, onDelta)
      : (model, msgs, t, onDelta) => invokeModelTurn(model, msgs, t, onDelta);

    console.log(`Mode: ${STREAMING ? 'streaming' : 'non-streaming'}`);
    console.log('================================================');

    const result = await runLoop(modelCall, messages, tools, {
      model: MODEL,
      streaming: STREAMING,
      mode: RESEARCH_MODE.name,
      limits: RESEARCH_MODE.limits,
      trace: consoleTrace,
      emit: (event) => {
        events.push({ seq: 0, ...event } as AgentEvent);
        if (event.type === 'assistant.delta') {
          process.stdout.write(event.delta);
        }
      },
    });

    if (!STREAMING) {
      console.log('Result:', result.content);
    } else {
      console.log('');
    }
    console.log('Iterations:', result.iterations);
    console.log('Tool calls:', result.toolCalls);
    console.log('Events emitted:', events.length);
    console.log('================================================');
  } catch (error) {
    console.error('Something went wrong:', error);
  }
}

main();

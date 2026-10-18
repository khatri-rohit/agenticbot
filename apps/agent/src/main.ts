import 'dotenv/config';
import path from 'node:path';

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
  modeForKind,
} from '@org/agent-core';

const STREAMING = process.env.STREAMING === '1';

function parseHarnessArgs(argv: string[]): {
  mode: 'research' | 'coding';
  workspace?: string;
  query: string;
} {
  let mode: 'research' | 'coding' = 'research';
  let workspace: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mode') {
      const value = argv[++i];
      if (value === 'coding' || value === 'research') mode = value;
      continue;
    }
    if (arg === '--workspace') {
      workspace = argv[++i];
      continue;
    }
    rest.push(arg);
  }
  return { mode, workspace, query: rest.join(' ').trim() };
}

async function main() {
  try {
    const parsed = parseHarnessArgs(process.argv.slice(2));
    const mode = modeForKind(parsed.mode);
    const workspaceRoot = parsed.workspace
      ? path.resolve(parsed.workspace)
      : undefined;
    if (parsed.mode === 'coding' && !workspaceRoot) {
      throw new Error('coding mode requires --workspace <path>');
    }

    const query =
      parsed.query ||
      (parsed.mode === 'coding'
        ? 'List the files in this workspace and say what the project appears to be.'
        : 'What is value of PI in 3 decimal places?');

    const tools = createToolRegistry(ALL_TOOLS, [
      ...new Set([...mode.allowedTools, ...mode.globalTools]),
    ]);
    const messages = getContext(query, tools);

    const events: AgentEvent[] = [];
    const modelCall: ModelCallFn = STREAMING
      ? (model, msgs, t, onDelta) => streamModelTurn(model, msgs, t, onDelta)
      : (model, msgs, t, onDelta) => invokeModelTurn(model, msgs, t, onDelta);

    console.log(`Mode: ${mode.name} (${STREAMING ? 'streaming' : 'non-streaming'})`);
    if (workspaceRoot) console.log(`Workspace: ${workspaceRoot}`);
    console.log('================================================');

    const result = await runLoop(modelCall, messages, tools, {
      model: mode.model,
      streaming: STREAMING,
      mode: mode.name,
      limits: mode.limits,
      ...(workspaceRoot ? { workspaceRoot } : {}),
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
    process.exitCode = 1;
  }
}

main();

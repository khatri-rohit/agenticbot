import 'dotenv/config';
import path from 'node:path';

import type { AgentEvent, ModeName } from '@org/agent-models';
import {
  runLoop,
  invokeModelTurn,
  streamModelTurn,
  getContext,
  createToolRegistry,
  ALL_TOOLS,
  consoleTrace,
  loadWorkspaceRules,
  type ModelCallFn,
  modeForKind,
} from '@org/agent-core';
import { normalizeThreadKind } from '@org/agent-models';

const STREAMING = process.env.STREAMING === '1';

function parseHarnessArgs(argv: string[]): {
  mode: ModeName;
  workspace?: string;
  query: string;
} {
  let mode: ModeName = 'home';
  let workspace: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--mode') {
      const value = argv[++i];
      if (
        value === 'home' ||
        value === 'workspace' ||
        value === 'research' ||
        value === 'coding'
      ) {
        mode = normalizeThreadKind(value);
      }
      continue;
    }
    if (arg === '--workspace') {
      workspace = argv[++i];
      mode = 'workspace';
      continue;
    }
    rest.push(arg);
  }
  return { mode, workspace, query: rest.join(' ').trim() };
}

async function main() {
  try {
    const parsed = parseHarnessArgs(process.argv.slice(2));
    const kind = normalizeThreadKind(parsed.mode);
    const mode = modeForKind(kind);
    const workspaceRoot = parsed.workspace
      ? path.resolve(parsed.workspace)
      : undefined;
    if (kind === 'workspace' && !workspaceRoot) {
      throw new Error('workspace profile requires --workspace <path>');
    }

    const query =
      parsed.query ||
      (kind === 'workspace'
        ? 'List the files in this workspace and say what the project appears to be.'
        : 'What is value of PI in 3 decimal places?');

    const tools = createToolRegistry(ALL_TOOLS, [
      ...new Set([...mode.allowedTools, ...mode.globalTools]),
    ]);
    const messages = getContext(query, tools, mode.name);
    if (workspaceRoot) {
      const rules = await loadWorkspaceRules(workspaceRoot);
      const extra = [
        rules.agentsMd
          ? `# Project instructions (AGENTS.md)\n${rules.agentsMd}`
          : '',
        rules.project ? `# Project notes (PROJECT.md)\n${rules.project}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      if (extra) {
        messages.splice(1, 0, { role: 'system', content: extra });
      }
    }

    const events: AgentEvent[] = [];
    const callOptions = { temperature: mode.temperature };
    const modelCall: ModelCallFn = STREAMING
      ? (model, msgs, t, onDelta) =>
          streamModelTurn(model, msgs, t, onDelta, callOptions)
      : (model, msgs, t, onDelta) =>
          invokeModelTurn(model, msgs, t, onDelta, callOptions);

    console.log(`Profile: ${mode.name} (${STREAMING ? 'streaming' : 'non-streaming'})`);
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

import 'dotenv/config';
import path from 'node:path';

import type { AgentEvent, ModeName, RunPosture } from '@org/agent-models';
import {
  applyPostureToTools,
  normalizeRunPosture,
  normalizeThreadKind,
} from '@org/agent-models';
import {
  runLoop,
  invokeModelTurn,
  streamModelTurn,
  assembleContext,
  createToolRegistry,
  ALL_TOOLS,
  consoleTrace,
  loadWorkspaceRules,
  type ModelCallFn,
  modeForKind,
} from '@org/agent-core';

const STREAMING = process.env.STREAMING === '1';

function parseHarnessArgs(argv: string[]): {
  mode: ModeName;
  workspace?: string;
  posture: RunPosture;
  query: string;
} {
  let mode: ModeName = 'home';
  let workspace: string | undefined;
  let posture: RunPosture = 'agent';
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
    if (arg === '--ask') {
      posture = 'ask';
      continue;
    }
    rest.push(arg);
  }
  return { mode, workspace, posture, query: rest.join(' ').trim() };
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
    const posture =
      kind === 'workspace' ? normalizeRunPosture(parsed.posture) : 'agent';

    const query =
      parsed.query ||
      (kind === 'workspace'
        ? posture === 'ask'
          ? 'List the files in this workspace and say what the project appears to be. Do not edit.'
          : 'List the files in this workspace and say what the project appears to be.'
        : 'What is value of PI in 3 decimal places?');

    const toolNames = applyPostureToTools(
      [...new Set([...mode.allowedTools, ...mode.globalTools])],
      posture,
    );
    const tools = createToolRegistry(ALL_TOOLS, toolNames, posture);
    const rules = workspaceRoot
      ? await loadWorkspaceRules(workspaceRoot)
      : { agentsMd: '', project: '' };
    const { messages } = assembleContext({
      tools,
      memory: {
        user: '',
        notes: '',
        ...(rules.agentsMd ? { agentsMd: rules.agentsMd } : {}),
        ...(rules.project ? { project: rules.project } : {}),
      },
      snapshot: null,
      envelopes: [
        {
          v: 1,
          seq: 1,
          ts: new Date().toISOString(),
          threadId: 'cli',
          runId: null,
          record: { role: 'user', content: query },
        },
      ],
      mode: mode.name,
      posture,
    });

    const events: AgentEvent[] = [];
    const callOptions = { temperature: mode.temperature };
    const modelCall: ModelCallFn = STREAMING
      ? (model, msgs, t, onDelta) =>
          streamModelTurn(model, msgs, t, onDelta, callOptions)
      : (model, msgs, t, onDelta) =>
          invokeModelTurn(model, msgs, t, onDelta, callOptions);

    console.log(
      `Profile: ${mode.name} / ${posture} (${STREAMING ? 'streaming' : 'non-streaming'})`,
    );
    if (workspaceRoot) console.log(`Workspace: ${workspaceRoot}`);
    console.log('================================================');

    const result = await runLoop(modelCall, messages, tools, {
      model: mode.model,
      streaming: STREAMING,
      mode: mode.name,
      posture,
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
    console.log('================================================');
    console.log('Status:', result.status, '| iterations:', result.iterations);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
}

void main();

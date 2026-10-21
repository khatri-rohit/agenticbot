import 'dotenv/config';
import path from 'node:path';

import type { AgentEvent, ModeName, RunPosture } from '@agenticbot/agent-models';
import {
  applyPostureToTools,
  modeForKind,
  normalizeRunPosture,
  normalizeThreadKind,
  planHasOpenWork,
} from '@agenticbot/agent-models';
import {
  runLoop,
  streamModelTurn,
  assembleContext,
  createToolRegistry,
  ALL_TOOLS,
  consoleTrace,
  createInMemoryPlanStore,
  createPlanTools,
  loadWorkspaceRules,
  type ModelCallFn,
} from '@agenticbot/agent-core';


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
    const planStore = createInMemoryPlanStore('cli');
    const tools = createToolRegistry(
      [...ALL_TOOLS, ...createPlanTools(planStore)],
      toolNames,
      posture,
    );
    const plan = await planStore.read();
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
      plan,
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
    const modelCall: ModelCallFn = (model, msgs, t, onDelta) =>
      streamModelTurn(model, msgs, t, onDelta, callOptions);

    console.log(
      `Profile: ${mode.name} / ${posture} (streaming)`,
    );
    if (workspaceRoot) console.log(`Workspace: ${workspaceRoot}`);
    console.log('================================================');

    const result = await runLoop(modelCall, messages, tools, {
      model: mode.model,
      mode: mode.name,
      posture,
      limits: mode.limits,
      hasOpenPlanWork: async () => planHasOpenWork(await planStore.read()),
      ...(workspaceRoot ? { workspaceRoot } : {}),
      approve: async (request) => {
        const first = request.options?.[0];
        if (!first) {
          throw new Error('ask_user requires options');
        }
        console.log(`[auto-approve] ${request.toolName}: ${request.summary} → ${first.label}`);
        return { optionId: first.id };
      },
      offerChoice: async (request) => {
        const first = request.options[0];
        if (!first) return { optionIds: [] };
        console.log(`[auto-choice] ${request.question} → ${first.label}`);
        return { optionIds: [first.id] };
      },
      trace: consoleTrace,
      emit: (event) => {
        events.push({ seq: 0, ...event } as AgentEvent);
        if (event.type === 'assistant.delta') {
          process.stdout.write(event.delta);
        }
      },
    });

    console.log('');
    console.log('================================================');
    console.log('Status:', result.status, '| iterations:', result.iterations);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
}

void main();

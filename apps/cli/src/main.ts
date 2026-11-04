import 'dotenv/config';
import path from 'node:path';

import type { ModeName, RunPosture } from '@agent/agent-models';
import {
  modeForKind,
  normalizeRunPosture,
  normalizeThreadKind,
} from '@agent/agent-models';
import {
  streamModelTurn,
  consoleTrace,
  teeTrace,
  type ModelCallFn,
} from '@agent/agent-core';
import { runLocally } from './local-run.js';
import { createJsonlTraceSink } from './trace-sink.js';


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

    const callOptions = { temperature: mode.temperature };
    const modelCall: ModelCallFn = (model, msgs, t, onDelta) =>
      streamModelTurn(model, msgs, t, onDelta, callOptions);
    const tracesDir = path.join(__dirname, '..', 'traces');

    console.log(`Profile: ${mode.name} / ${posture} (streaming)`);
    if (workspaceRoot) console.log(`Workspace: ${workspaceRoot}`);
    console.log('================================================');

    const { result, outcome } = await runLocally({
      query,
      mode,
      posture,
      model: mode.model,
      modelCall,
      ...(workspaceRoot ? { workspaceRoot } : {}),
      trace: teeTrace(consoleTrace, createJsonlTraceSink(tracesDir)),
      onEvent: (event) => {
        if (event.type === 'assistant.delta') process.stdout.write(event.delta);
      },
    });

    console.log('');
    console.log('================================================');
    console.log('Status:', outcome, '| iterations:', result.iterations);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
}

void main();

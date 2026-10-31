#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import { loadSuite, ensureEvalsDir } from '../runner/task.js';
import { runSuite } from '../runner/runner.js';
import { runGate } from '../gate/gate.js';
import { recordBaseline } from '../gate/baseline.js';
import type { TaskResult } from '../runner/runner.js';

const evalsDir = process.env.EVALS_DIR ?? './evals';
const home = process.env.AGENT_HOME ?? process.env.HOME ?? '.';
const suiteArg = process.argv.find((a) => a.startsWith('--suite='))?.split('=')[1];
const updateBaseline = process.argv.includes('--update-baseline');

if (!suiteArg) {
  console.error('Usage: gate --suite=<name> [--update-baseline]');
  process.exit(1);
}

await ensureEvalsDir(evalsDir);
const tasks = await loadSuite(evalsDir, suiteArg);
if (tasks.length === 0) {
  console.error(`No tasks found for suite "${suiteArg}"`);
  process.exit(1);
}

const sha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
const model = process.env.EVAL_MODEL ?? 'gpt-oss:120b';

// Run the suite.
const result = await runSuite({ evalsDir, home, suite: suiteArg, tasks, repeat: 3 });

// Gate against baseline.
const gate = await runGate(evalsDir, suiteArg, result.tasks, sha, model);

if (gate.shaMismatch || gate.modelMismatch) {
  console.error(`Gate refused: baseline sha/model mismatch.`);
  console.error(`  baseline: ${gate.baselineHarnessSha} / ${gate.baselineModel}`);
  console.error(`  current:  ${gate.harnessSha} / ${gate.model}`);
  console.error(`Move model and harness together is not allowed.`);
  process.exit(1);
}

console.log(`\nGate ${suiteArg}: ${gate.passed ? 'PASS' : 'FAIL'}`);
for (const delta of gate.deltas) {
  const status = delta.passed ? '✓' : '✗';
  console.log(`  ${status} ${delta.taskId}: success ${delta.current.successRate.toFixed(2)} vs ${delta.baseline.successRate.toFixed(2)}, tokens ${delta.current.medianPromptTokens} vs ${delta.baseline.medianPromptTokens}`);
  if (delta.reasons.length > 0) {
    console.log(`      ${delta.reasons.join('; ')}`);
  }
}

if (gate.passed && updateBaseline) {
  await recordBaseline(evalsDir, suiteArg, result.tasks, sha, model);
  console.log(`Baseline updated for ${suiteArg}.`);
}

process.exit(gate.passed ? 0 : 1);
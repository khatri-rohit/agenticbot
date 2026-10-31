#!/usr/bin/env node
import { loadSuite, ensureEvalsDir } from '../runner/task.js';
import { runSuite } from '../runner/runner.js';

const evalsDir = process.env.EVALS_DIR ?? './evals';
const home = process.env.AGENT_HOME ?? process.env.HOME ?? '.';
const suiteArg = process.argv.find((a) => a.startsWith('--suite='))?.split('=')[1];
const repeatArg = process.argv.find((a) => a.startsWith('--repeat='))?.split('=')[1];

if (!suiteArg) {
  console.error('Usage: run --suite=<name> [--repeat=<n>]');
  process.exit(1);
}

await ensureEvalsDir(evalsDir);
const tasks = await loadSuite(evalsDir, suiteArg);
if (tasks.length === 0) {
  console.error(`No tasks found for suite "${suiteArg}" in ${evalsDir}/tasks/${suiteArg}/`);
  process.exit(1);
}

const result = await runSuite({
  evalsDir,
  home,
  suite: suiteArg,
  tasks,
  repeat: repeatArg ? parseInt(repeatArg, 10) : undefined,
});

const passed = result.tasks.filter((t) => t.status === 'pass').length;
const failed = result.tasks.filter((t) => t.status === 'fail').length;
const errors = result.tasks.filter((t) => t.status === 'error').length;
const skipped = result.tasks.filter((t) => t.status === 'skipped').length;
console.log(`\nSuite ${result.suite}: ${passed} pass, ${failed} fail, ${errors} error, ${skipped} skipped`);
console.log(`Results: ${evalsDir}/results/${result.label}/`);
process.exit(failed + errors > 0 ? 1 : 0);
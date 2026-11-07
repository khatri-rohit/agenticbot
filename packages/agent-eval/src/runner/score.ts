import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { exec, git } from './exec.js';
import type { EvalTask } from './task.js';

export type CheckResult = { run: string; exit: number; passed: boolean; timedOut: boolean; outTail: string };
export type FileResult = { path: string; passed: boolean; reason?: string };

export type Grade = {
  checks: CheckResult[];
  checksPassed: boolean;
  files: FileResult[];
  filesPassed: boolean;
  /** Paths changed in the workdir (tracked diffs + untracked, not ignored). */
  changed: string[];
  scopeViolations: string[];
  budget: { promptTokens: number; minutes: number; unresolvedLimit?: string; ok: boolean };
  passed: boolean;
};

const DEFAULT_CHECK_TIMEOUT_SEC = 300;

/** `scope.allow` entries: exact paths, `dir/` prefixes, or globs with `*` (one segment) and `**`. */
export function scopeMatcher(allow: string[]): (file: string) => boolean {
  const patterns = allow.map((entry) => {
    const pattern = entry.replace(/\\/g, '/');
    if (pattern.endsWith('/')) return (file: string) => file.startsWith(pattern);
    if (!pattern.includes('*')) return (file: string) => file === pattern;
    const source = pattern
      .split('**')
      .map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
      .join('.*');
    const regex = new RegExp(`^${source}$`);
    return (file: string) => regex.test(file);
  });
  return (file) => patterns.some((match) => match(file));
}

async function changedFiles(dir: string): Promise<string[]> {
  const tracked = await git(dir, ['diff', '--name-only', 'HEAD']);
  const untracked = await git(dir, ['ls-files', '--others', '--exclude-standard']);
  return [
    ...new Set(
      `${tracked.stdout}\n${untracked.stdout}`
        .split('\n')
        .map((line) => line.trim().replace(/\\/g, '/'))
        .filter(Boolean),
    ),
  ].sort();
}

/**
 * Grade a trial from the workdir's end state, cheapest first: checks
 * (commands), file assertions, scope, budget. Never reads the transcript.
 */
export async function gradeTrial(input: {
  task: EvalTask;
  dir: string;
  promptTokens: number;
  minutes: number;
  /** Set when the trial still ended on a run limit after its Continues. */
  unresolvedLimit?: string;
}): Promise<Grade> {
  const { task, dir } = input;
  const checks: CheckResult[] = [];
  for (const check of task.checks) {
    const result = await exec(check.run, [], {
      cwd: dir,
      shell: true,
      timeoutMs: (check.timeoutSec ?? DEFAULT_CHECK_TIMEOUT_SEC) * 1000,
    });
    checks.push({
      run: check.run,
      exit: result.code,
      passed: !result.timedOut && result.code === check.expectExit,
      timedOut: result.timedOut,
      outTail: result.out.slice(-1500),
    });
  }

  const files: FileResult[] = [];
  for (const entry of task.files) {
    try {
      const text = await readFile(path.join(dir, entry.path), 'utf8');
      const passed = new RegExp(entry.mustMatch, 'm').test(text);
      files.push({ path: entry.path, passed, ...(passed ? {} : { reason: `no match for /${entry.mustMatch}/` }) });
    } catch {
      files.push({ path: entry.path, passed: false, reason: 'file missing' });
    }
  }

  const changed = await changedFiles(dir);
  const allowed = scopeMatcher(task.scope.allow);
  const scopeViolations = changed.filter((file) => !allowed(file));

  const budgetOk =
    input.promptTokens <= task.budget.maxPromptTokens &&
    input.minutes <= task.budget.maxMinutes &&
    !input.unresolvedLimit;

  const checksPassed = checks.every((check) => check.passed);
  const filesPassed = files.every((file) => file.passed);
  return {
    checks,
    checksPassed,
    files,
    filesPassed,
    changed,
    scopeViolations,
    budget: {
      promptTokens: input.promptTokens,
      minutes: input.minutes,
      ...(input.unresolvedLimit ? { unresolvedLimit: input.unresolvedLimit } : {}),
      ok: budgetOk,
    },
    passed: checksPassed && filesPassed && scopeViolations.length === 0 && budgetOk,
  };
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { gradeTrial } from './score.js';
import { loadTasks, parseTask } from './task.js';

const tasksDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../evals/tasks');

describe('task matrix', () => {
  it('loads one task per shape, with answer checks where files cannot grade', async () => {
    const tasks = await loadTasks(tasksDir, { suite: 'matrix' });
    expect(tasks.map((loaded) => loaded.task.id)).toEqual([
      'm1-small-edit',
      'm2-multi-file-edit',
      'm3-read-only-extraction',
      'm4-plain-question',
      'm5-delegation-research',
      'm6-large-file',
      'm7-shell-commands',
    ]);
    for (const { task } of tasks) {
      // Every task grades something: a command, a file or the answer.
      expect(task.checks.length + task.files.length + (task.answer?.length ?? 0), task.id).toBeGreaterThan(0);
    }
    expect(tasks.find((loaded) => loaded.task.id === 'm4-plain-question')?.task.mode).toBe('home');
  });

  it('finds a matrix task by id without naming the suite', async () => {
    expect(await loadTasks(tasksDir, { id: 'm6-large-file' })).toHaveLength(1);
  });

  it('rejects an unknown mode and a non-array answer', () => {
    const base = { id: 'x', suite: 'matrix', repo: { source: '.', commit: 'abc' }, prompt: 'p', checks: [], files: [], scope: { allow: [] }, budget: { maxPromptTokens: 1, maxMinutes: 1 } };
    expect(() => parseTask('x.json', { ...base, mode: 'web' })).toThrow(/mode/);
    expect(() => parseTask('x.json', { ...base, answer: 'yes' })).toThrow(/answer/);
  });
});

describe('answer grading', () => {
  const task = parseTask('q.json', {
    id: 'q',
    suite: 'matrix',
    mode: 'home',
    repo: { source: '.', commit: 'abc' },
    prompt: 'p',
    checks: [{ run: 'exit 1', expectExit: 0 }],
    files: [{ path: 'missing.txt', mustMatch: 'x' }],
    answer: [{ mustMatch: 'address space' }],
    scope: { allow: [] },
    budget: { maxPromptTokens: 100, maxMinutes: 5 },
  });

  it('grades a home task on its answer and budget only (no workdir to run or read)', async () => {
    const grade = await gradeTrial({ task, answer: 'Threads share one Address Space.', promptTokens: 50, minutes: 1 });
    expect(grade.checks).toEqual([]);
    expect(grade.files).toEqual([]);
    expect(grade.answersPassed).toBe(true);
    expect(grade.passed).toBe(true);
  });

  it('fails a missing or wrong answer', async () => {
    expect((await gradeTrial({ task, promptTokens: 50, minutes: 1 })).passed).toBe(false);
    expect((await gradeTrial({ task, answer: 'no idea', promptTokens: 50, minutes: 1 })).answersPassed).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import type { TraceEvent } from '@agent/agent-models';

import { citedPath, inferTaskShape, isCheckCommand, TaskStateTracker } from './task-state';

const runId = 'r1';
const request = (iteration: number): TraceEvent => ({ type: 'llm_request', runId, iteration });
const start = (iteration: number, id: string, toolName: string, args: unknown): TraceEvent => ({
  type: 'tool_start',
  runId,
  iteration,
  toolName,
  toolCallId: id,
  args,
});
const complete = (
  iteration: number,
  id: string,
  toolName: string,
  resultPreview: string,
  extra: Partial<Extract<TraceEvent, { type: 'tool_complete' }>> = {},
): TraceEvent => ({ type: 'tool_complete', runId, iteration, toolName, toolCallId: id, durationMs: 0, resultPreview, ...extra });

function feed(tracker: TaskStateTracker, events: TraceEvent[]) {
  return events.map((event) => tracker.apply(event)).filter((change) => change !== null);
}

describe('TaskStateTracker', () => {
  it('walks orient → locate → change → verify → report, and records evidence', () => {
    const tracker = new TaskStateTracker();
    const changes = feed(tracker, [
      request(1),
      start(1, 'a', 'read_file', { path: './src/a.ts' }),
      complete(1, 'a', 'read_file', '[lines 1–120 of 120]\n…'),
      request(2),
      start(2, 'b', 'edit_file', { path: 'src/a.ts', oldText: 'x', newText: 'y' }),
      complete(2, 'b', 'edit_file', 'Patched src/a.ts', { outcome: 'ok' }),
      request(3),
      start(3, 'c', 'run_terminal', { command: 'npm test' }),
      complete(3, 'c', 'run_terminal', 'cwd: /w\nexit 0', { exitCode: 0 }),
      request(4),
      { type: 'llm_response', runId, iteration: 4, finishReason: 'stop', hasToolCalls: false },
    ]);
    expect(changes.map((change) => change.to)).toEqual(['locate', 'change', 'verify', 'report']);
    expect(changes[2]?.cause).toBe('check after edit');

    const state = tracker.snapshot();
    expect(state.phase).toBe('report');
    expect(state.iteration).toBe(4);
    // ./src/a.ts and src/a.ts are one working-set entry.
    expect(state.workingSet).toEqual([
      expect.objectContaining({
        path: 'src/a.ts',
        reads: 1,
        edits: 1,
        lastRange: { from: 1, to: 120, of: 120 },
        lastReadIteration: 1,
        lastEditIteration: 2,
      }),
    ]);
    expect(state.evidence).toMatchObject({
      edits: 1,
      failedEdits: 0,
      unverifiedSince: null,
      uncheckedFiles: [],
      reviewed: false,
    });
    const npmTest = { command: 'npm test', exitCode: 0, iteration: 3, afterEdit: true, check: true };
    expect(state.evidence.commands).toEqual([npmTest]);
    expect(state.evidence.lastCheck).toEqual(npmTest);
    expect(state.taskClass).toBe('small');
    // Each model call counts toward the phase the run was in when it was made.
    expect(state.phaseIterations).toEqual({ orient: 1, locate: 1, change: 1, verify: 1 });
  });

  it('re-reading an edited file stays in change; reading another file is locate', () => {
    const tracker = new TaskStateTracker();
    feed(tracker, [
      start(1, 'a', 'edit_file', { path: 'a.ts' }),
      complete(1, 'a', 'edit_file', 'Patched a.ts', { outcome: 'ok' }),
      start(2, 'b', 'read_file', { path: './a.ts' }),
    ]);
    expect(tracker.current).toBe('change');
    // The next fix of a multi-fix task: locating, with the edit still outstanding.
    feed(tracker, [start(3, 'c', 'read_file', { path: 'b.ts' })]);
    expect(tracker.current).toBe('locate');
    expect(tracker.snapshot().evidence.unverifiedSince).toBe(1);
  });

  it('counts failed edits and does not treat them as unverified changes', () => {
    const tracker = new TaskStateTracker();
    feed(tracker, [
      start(1, 'a', 'edit_file', { path: 'a.ts' }),
      complete(1, 'a', 'edit_file', 'Error: oldText matches 2 times', { outcome: 'error' }),
      start(2, 'b', 'edit_file', { path: 'a.ts' }),
      { type: 'tool_error', runId, iteration: 2, toolName: 'edit_file', toolCallId: 'b', error: 'boom' },
    ]);
    const state = tracker.snapshot();
    expect(state.evidence).toMatchObject({ edits: 0, failedEdits: 2, toolErrors: 1, unverifiedSince: null });
    expect(state.workingSet[0]).toMatchObject({ path: 'a.ts', failedEdits: 2, edits: 0 });
  });

  it('a command that did not run leaves the edit unverified', () => {
    const tracker = new TaskStateTracker();
    feed(tracker, [
      start(1, 'a', 'edit_file', { path: 'a.ts' }),
      complete(1, 'a', 'edit_file', 'Patched a.ts', { outcome: 'ok' }),
      start(2, 'b', 'run_terminal', { command: 'npm test' }),
      complete(2, 'b', 'run_terminal', 'cwd: /w\nexit timeout'),
    ]);
    expect(tracker.snapshot().evidence.unverifiedSince).toBe(1);
  });

  it('maps delegate profiles and limits', () => {
    const tracker = new TaskStateTracker();
    const changes = feed(tracker, [
      start(1, 'a', 'delegate', { profile: 'explore', objective: 'find x' }),
      start(2, 'b', 'delegate', { profile: 'review', objective: 'review' }),
      { type: 'limit', runId, iteration: 3, reason: 'limit.iterations' },
    ]);
    expect(changes.map((change) => `${change.to}:${change.cause}`)).toEqual([
      'locate:delegate explore',
      'verify:delegate review',
      'blocked:limit',
    ]);
  });
});

describe('TaskStateTracker after a limit', () => {
  it('stays blocked through the handoff answer', () => {
    const tracker = new TaskStateTracker();
    feed(tracker, [
      { type: 'limit', runId, iteration: 2, reason: 'limit.tokens' },
      { type: 'llm_response', runId, iteration: 2, finishReason: 'stop', hasToolCalls: false, final: true },
    ]);
    expect(tracker.current).toBe('blocked');
  });
});

describe('isCheckCommand', () => {
  it('counts builds, typechecks, tests and lints; not looking around', () => {
    for (const command of [
      'npm test',
      'npx nx run @agent/agent-core:typecheck',
      'npx nx run-many -t test -p @agent/web',
      'pnpm lint',
      'cargo check',
      'go vet ./...',
      'npx tsc --noEmit',
      'npm run build',
    ]) {
      expect(isCheckCommand(command), command).toBe(true);
    }
    for (const command of [
      'npx nx show project @agent/web --json',
      'git status',
      'git checkout -b x',
      'ls build',
      'cat package.json',
      'node scripts/print.js',
      '',
    ]) {
      expect(isCheckCommand(command), command).toBe(false);
    }
  });
});

describe('TaskStateTracker verification and class', () => {
  it('only a check that ran verifies edits; other commands are locate', () => {
    const tracker = new TaskStateTracker();
    const changes = feed(tracker, [
      start(1, 'a', 'edit_file', { path: 'a.ts' }),
      complete(1, 'a', 'edit_file', 'Patched a.ts', { outcome: 'ok' }),
      start(2, 'b', 'run_terminal', { command: 'npx nx show project @agent/web' }),
      complete(2, 'b', 'run_terminal', 'cwd: /w\nexit 0', { exitCode: 0 }),
    ]);
    expect(changes.at(-1)).toMatchObject({ to: 'locate', cause: 'command' });
    expect(tracker.unchecked).toBe(true);
    expect(tracker.isUnchecked('a.ts')).toBe(true);
    expect(tracker.snapshot().evidence.commands[0]).toMatchObject({ check: false, afterEdit: true });

    feed(tracker, [
      start(3, 'c', 'run_terminal', { command: 'npm test' }),
      complete(3, 'c', 'run_terminal', 'cwd: /w\nexit 1', { exitCode: 1 }),
    ]);
    // A failing check still ran: the edit is checked, and the failure is on record.
    expect(tracker.unchecked).toBe(false);
    expect(tracker.snapshot().evidence.lastCheck).toMatchObject({ exitCode: 1, check: true });
  });

  it('promotes the task class from evidence and never demotes it', () => {
    const tracker = new TaskStateTracker();
    const events: TraceEvent[] = [];
    for (let i = 1; i <= 3; i++) {
      events.push(start(i, `e${i}`, 'edit_file', { path: `f${i}.ts` }));
      events.push(complete(i, `e${i}`, 'edit_file', `Patched f${i}.ts`, { outcome: 'ok' }));
    }
    feed(tracker, [...events, request(4)]);
    expect(tracker.taskClass).toBe('medium'); // 3 edited files
    feed(tracker, [request(40)]);
    expect(tracker.taskClass).toBe('long');
    feed(tracker, [request(41)]);
    expect(tracker.taskClass).toBe('long');
  });

  it('records review and per-call iteration and file touches', () => {
    const tracker = new TaskStateTracker();
    feed(tracker, [
      request(5),
      start(5, 'r', 'read_file', { path: 'a.ts' }),
      complete(5, 'r', 'read_file', '[lines 1–10 of 10]'),
      start(7, 'd', 'delegate', { profile: 'review', objective: 'review' }),
    ]);
    expect(tracker.callIteration('r')).toBe(5);
    expect(tracker.lastTouch('a.ts')).toBe(5);
    expect(tracker.lastTouch('missing.ts')).toBeUndefined();
    expect(tracker.snapshot().evidence.reviewed).toBe(true);
  });
});

describe('task shape and findings', () => {
  it('starts the shape from the run setup, never from request words', () => {
    expect(inferTaskShape(false, 'agent')).toBe('answer');
    expect(inferTaskShape(false, 'ask')).toBe('answer');
    expect(inferTaskShape(true, 'ask')).toBe('research');
    expect(inferTaskShape(true, 'plan')).toBe('research');
    expect(inferTaskShape(true, 'agent')).toBe('unknown');
    expect(new TaskStateTracker().shape).toBe('unknown');
  });

  it('corrects the shape on the first edit', () => {
    const tracker = new TaskStateTracker();
    feed(tracker, [{ type: 'run_start', runId, model: 'm', taskShape: 'research' }]);
    expect(tracker.shape).toBe('research');
    feed(tracker, [
      request(1),
      start(1, 'e', 'edit_file', { path: 'a.ts' }),
      complete(1, 'e', 'edit_file', 'Patched a.ts', { outcome: 'ok' }),
    ]);
    expect(tracker.snapshot().shape).toBe('change');
  });

  it('moves unknown to research on a recorded finding; an edit wins over research', () => {
    const tracker = new TaskStateTracker();
    feed(tracker, [{ type: 'run_start', runId, model: 'm', taskShape: 'unknown' }, request(1)]);
    // An incomplete finding is no evidence.
    feed(tracker, [start(1, 'f0', 'record_finding', { claim: 'x', evidence: '' })]);
    expect(tracker.shape).toBe('unknown');
    feed(tracker, [start(1, 'f1', 'record_finding', { claim: 'Port is 3000', evidence: 'src/main.ts:12' })]);
    expect(tracker.shape).toBe('research');
    feed(tracker, [
      request(2),
      start(2, 'e', 'edit_file', { path: 'src/main.ts' }),
      complete(2, 'e', 'edit_file', 'Patched src/main.ts', { outcome: 'ok' }),
    ]);
    expect(tracker.shape).toBe('change');
    // A later finding does not take the change back.
    feed(tracker, [request(3), start(3, 'f2', 'record_finding', { claim: 'Port is now 4000', evidence: 'src/main.ts:12' })]);
    expect(tracker.shape).toBe('change');
  });

  it('records findings, ignores duplicates and incomplete ones, and knows the files they cite', () => {
    const tracker = new TaskStateTracker();
    feed(tracker, [
      request(3),
      start(3, 'f1', 'record_finding', { claim: 'Max 20 tiles', evidence: 'src/TileRibbon.tsx:104; src/IndividualTile.tsx:370-371' }),
      start(3, 'f2', 'record_finding', { claim: 'Max 20 tiles', evidence: 'src/TileRibbon.tsx:104' }),
      start(3, 'f3', 'record_finding', { claim: 'No evidence given', evidence: '' }),
      start(3, 'f4', 'record_finding', { claim: 'Docs say so', evidence: 'https://example.com/page' }),
    ]);
    const findings = tracker.snapshot().evidence.findings;
    expect(findings.map((finding) => finding.claim)).toEqual(['Max 20 tiles', 'Docs say so']);
    expect(findings[0]).toMatchObject({ iteration: 3 });
    expect(tracker.findingCount).toBe(2);
    expect(tracker.isCited('src/TileRibbon.tsx')).toBe(true);
    expect(tracker.isCited('src/IndividualTile.tsx')).toBe(true);
    expect(tracker.isCited('https://example.com/page')).toBe(false);
  });

  it('reads a cited path from path:line evidence and skips URLs and quotes', () => {
    expect(citedPath('src/a.ts:12')).toBe('src/a.ts');
    expect(citedPath('./src/a.ts:12-30')).toBe('src/a.ts');
    expect(citedPath('src/a.ts')).toBe('src/a.ts');
    expect(citedPath('https://x.dev/a')).toBeNull();
    expect(citedPath('"Maximum tile limit"')).toBeNull();
    expect(citedPath('somewhere')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';

import type { TraceEvent } from '@agent/agent-models';

import { TaskStateTracker } from './task-state';

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
    expect(changes[2]?.cause).toBe('command after edit');

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
    expect(state.evidence).toMatchObject({ edits: 1, failedEdits: 0, unverifiedSince: null });
    expect(state.evidence.commands).toEqual([
      { command: 'npm test', exitCode: 0, iteration: 3, afterEdit: true },
    ]);
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

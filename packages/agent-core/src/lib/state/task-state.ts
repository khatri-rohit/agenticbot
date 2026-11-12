import {
  TASK_STATE_COMMANDS_MAX,
  type TaskEvidence,
  type TaskPhase,
  type TaskStateSnapshot,
  type TraceEvent,
  type WorkingSetEntry,
} from '@agent/agent-models';

import { pathFromToolArgs } from '../loop/call-identity';

/**
 * Reduces loop trace events into the run's task state (phase, working set,
 * evidence). Deterministic and model-free: it reads exactly what the trace
 * sink records, so an offline reader can rebuild the same state from a
 * trace file. Read-only for now: it reports, nothing acts on it yet.
 */

export type PhaseChange = { from: TaskPhase; to: TaskPhase; cause: string };

const LOCATE_TOOLS = new Set([
  'read_file',
  'grep',
  'glob',
  'diff',
  'recall',
  'web_search',
  'web_fetch',
  'session_search',
]);

const RANGE_RE = /^\[lines (\d+)–(\d+) of (\d+)/;

function argString(args: unknown, key: string): string {
  if (args === null || typeof args !== 'object') return '';
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

export class TaskStateTracker {
  private phase: TaskPhase = 'orient';
  private currentIteration = 0;
  private readonly workingSet = new Map<string, WorkingSetEntry>();
  private readonly evidence: TaskEvidence = {
    edits: 0,
    failedEdits: 0,
    commands: [],
    toolErrors: 0,
    unverifiedSince: null,
  };
  private readonly phaseIterations: Partial<Record<TaskPhase, number>> = {};
  private readonly calls = new Map<string, { name: string; args: unknown }>();
  /** Files with a successful edit since the last command that ran. */
  private readonly editedSinceVerify = new Set<string>();

  get current(): TaskPhase {
    return this.phase;
  }

  /** Iteration of the latest model call. */
  get iteration(): number {
    return this.currentIteration;
  }

  /** Fold one event in; returns the phase change it caused, if any. */
  apply(event: TraceEvent): PhaseChange | null {
    switch (event.type) {
      case 'llm_request':
        if (event.final) return null;
        this.currentIteration = event.iteration;
        this.phaseIterations[this.phase] = (this.phaseIterations[this.phase] ?? 0) + 1;
        return null;
      case 'llm_response':
        // An answer without tool calls is a report (a stop check may still
        // send the run back; the next tool call moves the phase again). The
        // answer after a limit is its handoff: the run stays blocked.
        if (event.hasToolCalls || this.phase === 'blocked') return null;
        return this.move('report', 'answer');
      case 'tool_start':
        if (event.toolCallId) this.calls.set(event.toolCallId, { name: event.toolName, args: event.args });
        return this.onToolStart(event.toolName, event.args);
      case 'tool_complete':
        this.onToolComplete(event);
        return null;
      case 'tool_error':
        this.evidence.toolErrors += 1;
        if (event.toolName === 'edit_file') {
          this.evidence.failedEdits += 1;
          const path = pathFromToolArgs(event.toolCallId ? this.calls.get(event.toolCallId)?.args : undefined);
          if (path) this.entry(path).failedEdits += 1;
        }
        return null;
      case 'limit':
        return this.move('blocked', 'limit');
      default:
        return null;
    }
  }

  snapshot(): TaskStateSnapshot {
    return {
      phase: this.phase,
      iteration: this.currentIteration,
      workingSet: [...this.workingSet.values()].map((entry) => ({ ...entry })),
      evidence: { ...this.evidence, commands: [...this.evidence.commands] },
      phaseIterations: { ...this.phaseIterations },
    };
  }

  private onToolStart(name: string, args: unknown): PhaseChange | null {
    if (name === 'edit_file') return this.move('change', 'edit_file');
    if (name === 'run_terminal') {
      if (this.evidence.unverifiedSince !== null) return this.move('verify', 'command after edit');
      return this.evidence.edits > 0 ? this.move('verify', 'command') : this.move('locate', 'command');
    }
    if (name === 'delegate') {
      const profile = argString(args, 'profile');
      if (profile === 'review') return this.move('verify', 'delegate review');
      if (profile === 'explore') return this.move('locate', 'delegate explore');
      return null;
    }
    if (LOCATE_TOOLS.has(name)) {
      // Re-reading a file edited since the last verification is part of that
      // change; anything else is locating (often the next fix of a multi-fix
      // task). Outstanding edits stay visible in evidence.unverifiedSince.
      const path = name === 'read_file' ? pathFromToolArgs(args) : null;
      if (path !== null && this.editedSinceVerify.has(path)) return this.move('change', name);
      return this.move('locate', name);
    }
    return null;
  }

  private onToolComplete(event: Extract<TraceEvent, { type: 'tool_complete' }>): void {
    const call = event.toolCallId ? this.calls.get(event.toolCallId) : undefined;
    const path = pathFromToolArgs(call?.args) ?? '';
    if (event.toolName === 'read_file' && path) {
      const entry = this.entry(path);
      entry.reads += 1;
      entry.lastReadIteration = event.iteration;
      const range = RANGE_RE.exec(event.resultPreview);
      if (range) {
        entry.lastRange = { from: Number(range[1]), to: Number(range[2]), of: Number(range[3]) };
      }
      return;
    }
    if (event.toolName === 'edit_file') {
      if (event.outcome === 'error') {
        this.evidence.failedEdits += 1;
        if (path) this.entry(path).failedEdits += 1;
        return;
      }
      this.evidence.edits += 1;
      this.evidence.unverifiedSince ??= event.iteration;
      if (path) {
        this.editedSinceVerify.add(path);
        const entry = this.entry(path);
        entry.edits += 1;
        entry.lastEditIteration = event.iteration;
      }
      return;
    }
    if (event.toolName === 'run_terminal') {
      const ran = event.exitCode !== undefined;
      this.evidence.commands.push({
        command: argString(call?.args, 'command'),
        ...(ran ? { exitCode: event.exitCode } : {}),
        iteration: event.iteration,
        afterEdit: this.evidence.unverifiedSince !== null,
      });
      if (this.evidence.commands.length > TASK_STATE_COMMANDS_MAX) this.evidence.commands.shift();
      if (ran) {
        this.evidence.unverifiedSince = null;
        this.editedSinceVerify.clear();
      }
    }
  }

  private entry(path: string): WorkingSetEntry {
    let entry = this.workingSet.get(path);
    if (!entry) {
      entry = { path, reads: 0, edits: 0, failedEdits: 0 };
      this.workingSet.set(path, entry);
    }
    return entry;
  }

  private move(to: TaskPhase, cause: string): PhaseChange | null {
    if (this.phase === to) return null;
    const change = { from: this.phase, to, cause };
    this.phase = to;
    return change;
  }
}

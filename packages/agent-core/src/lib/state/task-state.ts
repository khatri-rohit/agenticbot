import {
  TASK_STATE_COMMANDS_MAX,
  type TaskClass,
  type TaskCommand,
  type TaskPhase,
  type TaskStateSnapshot,
  type TraceEvent,
  type WorkingSetEntry,
} from '@agent/agent-models';

import { pathFromToolArgs } from '../loop/call-identity';

/**
 * Reduces loop trace events into the run's task state (phase, working set,
 * evidence, task class). Deterministic and model-free: it reads exactly what
 * the trace sink records, so an offline reader can rebuild the same state
 * from a trace file. Residency, the harness card and the stop check read it.
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

/** Words that make a command a project check. */
const CHECK_RE =
  /\b(test|tests|typecheck|type-check|tsc|lint|eslint|build|compile|check|vet|clippy|vitest|jest|pytest|mocha)\b/i;
/** Commands that only look around, whatever their arguments contain. */
const LOOK_ONLY_RE = /^(ls|dir|cat|type|head|tail|echo|pwd|cd|find|git|which|where|tree)\b/i;

/**
 * A project check: build, typecheck, test, lint or compile. Only a check
 * that ran verifies edits; `git status` or `nx show project` do not.
 * Heuristic by design (word match on the command), kept in one place.
 */
export function isCheckCommand(command: string): boolean {
  const trimmed = command.trim();
  return trimmed.length > 0 && !LOOK_ONLY_RE.test(trimmed) && CHECK_RE.test(trimmed);
}

function argString(args: unknown, key: string): string {
  if (args === null || typeof args !== 'object') return '';
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.trim() : '';
}

const CLASS_RANK: Record<TaskClass, number> = { small: 0, medium: 1, long: 2 };

export class TaskStateTracker {
  private phase: TaskPhase = 'orient';
  private currentIteration = 0;
  private klass: TaskClass = 'small';
  private readonly workingSet = new Map<string, WorkingSetEntry>();
  private edits = 0;
  private failedEdits = 0;
  private toolErrors = 0;
  private unverifiedSince: number | null = null;
  private lastCheck: TaskCommand | null = null;
  private reviewed = false;
  private readonly commands: TaskCommand[] = [];
  private readonly phaseIterations: Partial<Record<TaskPhase, number>> = {};
  private readonly calls = new Map<string, { name: string; args: unknown; iteration: number }>();
  /** Files with a successful edit since the last check that ran. */
  private readonly uncheckedFiles = new Set<string>();

  get current(): TaskPhase {
    return this.phase;
  }

  /** Iteration of the latest model call. */
  get iteration(): number {
    return this.currentIteration;
  }

  get taskClass(): TaskClass {
    return this.klass;
  }

  /** A successful edit has no check after it yet. */
  get unchecked(): boolean {
    return this.unverifiedSince !== null;
  }

  /** Iteration a tool call started in. */
  callIteration(toolCallId: string): number | undefined {
    return this.calls.get(toolCallId)?.iteration;
  }

  /** Latest iteration this path was read or edited. */
  lastTouch(path: string): number | undefined {
    const entry = this.workingSet.get(path);
    if (!entry) return undefined;
    const touches = [entry.lastReadIteration, entry.lastEditIteration].filter(
      (value): value is number => value !== undefined,
    );
    return touches.length > 0 ? Math.max(...touches) : undefined;
  }

  /** The path was edited since the last check that ran (it is being changed). */
  isUnchecked(path: string): boolean {
    return this.uncheckedFiles.has(path);
  }

  /** Fold one event in; returns the phase change it caused, if any. */
  apply(event: TraceEvent): PhaseChange | null {
    switch (event.type) {
      case 'llm_request':
        if (event.final) return null;
        this.currentIteration = event.iteration;
        this.phaseIterations[this.phase] = (this.phaseIterations[this.phase] ?? 0) + 1;
        this.promote();
        return null;
      case 'llm_response':
        // An answer without tool calls is a report (a stop check may still
        // send the run back; the next tool call moves the phase again). The
        // answer after a limit is its handoff: the run stays blocked.
        if (event.hasToolCalls || this.phase === 'blocked') return null;
        return this.move('report', 'answer');
      case 'tool_start':
        if (event.toolCallId) {
          this.calls.set(event.toolCallId, {
            name: event.toolName,
            args: event.args,
            iteration: event.iteration,
          });
        }
        return this.onToolStart(event.toolName, event.args);
      case 'tool_complete':
        this.onToolComplete(event);
        return null;
      case 'tool_error':
        this.toolErrors += 1;
        if (event.toolName === 'edit_file') {
          this.failedEdits += 1;
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
      taskClass: this.klass,
      workingSet: [...this.workingSet.values()].map((entry) => ({ ...entry })),
      evidence: {
        edits: this.edits,
        failedEdits: this.failedEdits,
        commands: [...this.commands],
        toolErrors: this.toolErrors,
        unverifiedSince: this.unverifiedSince,
        uncheckedFiles: [...this.uncheckedFiles],
        lastCheck: this.lastCheck,
        reviewed: this.reviewed,
      },
      phaseIterations: { ...this.phaseIterations },
    };
  }

  private onToolStart(name: string, args: unknown): PhaseChange | null {
    if (name === 'edit_file') return this.move('change', 'edit_file');
    if (name === 'run_terminal') {
      if (!isCheckCommand(argString(args, 'command'))) return this.move('locate', 'command');
      return this.move('verify', this.unverifiedSince !== null ? 'check after edit' : 'check');
    }
    if (name === 'delegate') {
      const profile = argString(args, 'profile');
      if (profile === 'review') {
        this.reviewed = true;
        return this.move('verify', 'delegate review');
      }
      if (profile === 'explore') return this.move('locate', 'delegate explore');
      return null;
    }
    if (LOCATE_TOOLS.has(name)) {
      // Re-reading a file edited since the last check is part of that change;
      // anything else is locating (often the next fix of a multi-fix task).
      // Outstanding edits stay visible in evidence.unverifiedSince.
      const path = name === 'read_file' ? pathFromToolArgs(args) : null;
      if (path !== null && this.uncheckedFiles.has(path)) return this.move('change', name);
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
        this.failedEdits += 1;
        if (path) this.entry(path).failedEdits += 1;
        return;
      }
      this.edits += 1;
      this.unverifiedSince ??= event.iteration;
      if (path) {
        this.uncheckedFiles.add(path);
        const entry = this.entry(path);
        entry.edits += 1;
        entry.lastEditIteration = event.iteration;
      }
      return;
    }
    if (event.toolName === 'run_terminal') {
      const command = argString(call?.args, 'command');
      const ran = event.exitCode !== undefined;
      const record: TaskCommand = {
        command,
        ...(ran ? { exitCode: event.exitCode } : {}),
        iteration: event.iteration,
        afterEdit: this.unverifiedSince !== null,
        check: isCheckCommand(command),
      };
      this.commands.push(record);
      if (this.commands.length > TASK_STATE_COMMANDS_MAX) this.commands.shift();
      if (ran && record.check) {
        this.lastCheck = record;
        this.unverifiedSince = null;
        this.uncheckedFiles.clear();
      }
    }
  }

  /** Promote the class as evidence grows; never demote within a run. */
  private promote(): void {
    const editedFiles = [...this.workingSet.values()].filter((entry) => entry.edits > 0).length;
    const next: TaskClass =
      this.currentIteration >= 40 || editedFiles >= 8
        ? 'long'
        : editedFiles > 2 || this.edits > 3 || this.currentIteration >= 12
          ? 'medium'
          : 'small';
    if (CLASS_RANK[next] > CLASS_RANK[this.klass]) this.klass = next;
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

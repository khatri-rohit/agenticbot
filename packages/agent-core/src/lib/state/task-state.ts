import {
  FINDING_CLAIM_MAX_CHARS,
  FINDING_EVIDENCE_MAX_CHARS,
  FINDINGS_MAX,
  TASK_STATE_COMMANDS_MAX,
  type RunPosture,
  type TaskClass,
  type TaskCommand,
  type TaskFinding,
  type TaskPhase,
  type TaskShape,
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

/**
 * The task's provisional shape from the run's setup, never from the
 * request's words. A home run (no workspace) answers; a read-only posture
 * (ask, plan) cannot edit, so it researches; an agent in a workspace is
 * unknown until evidence says: an edit makes it a change, a recorded
 * finding makes it research.
 */
export function inferTaskShape(hasWorkspace: boolean, posture: RunPosture): TaskShape {
  if (!hasWorkspace) return 'answer';
  return posture === 'agent' ? 'unknown' : 'research';
}

/** `src/a.ts:12`, `src/a.ts:12-30` or `src/a.ts` → `src/a.ts`; URLs and quotes → null. */
export function citedPath(evidence: string): string | null {
  const first = evidence.trim().split(/[\s,;]+/)[0] ?? '';
  if (!first || /^[a-z]+:\/\//i.test(first) || /^["'`]/.test(first)) return null;
  const path = first.replace(/:\d+(?:[-–]\d+)?$/, '').replace(/\\/g, '/').replace(/^\.\//, '');
  return /[./]/.test(path) ? path : null;
}

export class TaskStateTracker {
  private phase: TaskPhase = 'orient';
  private currentIteration = 0;
  private klass: TaskClass = 'small';
  private shapeValue: TaskShape = 'unknown';
  private readonly findings: TaskFinding[] = [];
  /** Paths a recorded finding cites (its evidence names them). */
  private readonly cited = new Set<string>();
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

  get shape(): TaskShape {
    return this.shapeValue;
  }

  /** Findings recorded so far. */
  get findingCount(): number {
    return this.findings.length;
  }

  /** Set the provisional shape at the start of a run (see inferTaskShape). */
  setShape(shape: TaskShape): void {
    this.shapeValue = shape;
  }

  /** A recorded finding cites this path, so the finding stands for its reads. */
  isCited(path: string): boolean {
    return this.cited.has(path);
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
      case 'run_start':
        if (event.taskShape) this.shapeValue = event.taskShape;
        return null;
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
      shape: this.shapeValue,
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
        findings: this.findings.map((finding) => ({ ...finding })),
      },
      phaseIterations: { ...this.phaseIterations },
    };
  }

  private onToolStart(name: string, args: unknown): PhaseChange | null {
    if (name === 'record_finding') {
      this.recordFinding(args);
      return null;
    }
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
      // An edit is a change, whatever the request looked like.
      this.shapeValue = 'change';
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

  /**
   * Record one finding from record_finding's arguments (the tool validates
   * them for the model; this keeps the state sane on its own). Duplicates of
   * a claim are ignored; the oldest leave past FINDINGS_MAX.
   */
  private recordFinding(args: unknown): void {
    const claim = argString(args, 'claim').slice(0, FINDING_CLAIM_MAX_CHARS);
    const evidence = argString(args, 'evidence').slice(0, FINDING_EVIDENCE_MAX_CHARS);
    if (!claim || !evidence) return;
    if (this.findings.some((finding) => finding.claim === claim)) return;
    const topic = argString(args, 'topic');
    this.findings.push({ claim, evidence, ...(topic ? { topic } : {}), iteration: this.currentIteration });
    if (this.findings.length > FINDINGS_MAX) this.findings.shift();
    for (const part of evidence.split(/[;,]\s*/)) {
      const path = citedPath(part);
      if (path) this.cited.add(path);
    }
    // A recorded fact is research evidence; an edit still outranks it.
    if (this.shapeValue !== 'change') this.shapeValue = 'research';
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

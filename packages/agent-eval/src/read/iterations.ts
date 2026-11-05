import type { System1EffortTrace, ToolStage } from '@agent/agent-models';

import type { TraceLine, TraceLineOf } from './trace.js';

/** A tool call as the iteration ran it. */
export type IterationTool = {
  toolCallId?: string;
  name: string;
  stage: ToolStage;
  args: unknown;
  /** `ok` / `error` from the tool's classifier, `threw` for tool_error, undefined while unknown (old trace, no classifier). */
  outcome?: 'ok' | 'error' | 'threw';
  exitCode?: number;
  durationMs?: number;
  resultPreview?: string;
  startSeq?: number;
};

/** One model call and what the loop did with its answer. Tools-off finals are their own entry. */
export type Iteration = {
  iteration: number;
  final: boolean;
  request?: TraceLineOf<'llm_request'>;
  response?: TraceLineOf<'llm_response'>;
  system1?: System1EffortTrace;
  tools: IterationTool[];
  /** Harness actions in this iteration: evictions, compactions, nudges, gates, limits, skills, memory. */
  markers: TraceLine[];
};

const MARKERS = new Set<string>([
  'context_evicted',
  'context_compacted_inrun',
  'context_prefix_heavy',
  'limit',
  'stall_nudge',
  'research_gate',
  'budget_warning',
  'tool_note',
  'skill_loaded',
  'skill_evicted',
  'memory_gate',
]);

/**
 * A copy of each built-in tool's stage for traces written before
 * `tool_start.stage` existed (agent-core `Tool.stage`). Unknown tools are mutate.
 */
export function legacyToolStage(name: string): ToolStage {
  if (name === 'load_skill') return 'skill';
  if (['glob', 'grep', 'read_file', 'recall', 'diff', 'report'].includes(name)) return 'read';
  if (name === 'web_search' || name === 'web_fetch') return 'network';
  if (name === 'delegate') return 'subagent';
  if (name === 'run_terminal') return 'exec';
  return 'mutate';
}

/** Old traces: edit_file results start with "Created" or "Patched" on success. */
function legacyEditOutcome(name: string, preview: string): 'ok' | 'error' | undefined {
  if (name !== 'edit_file') return undefined;
  return preview.startsWith('Created') || preview.startsWith('Patched') ? 'ok' : 'error';
}

/**
 * The run's iterations in order: the one place iteration boundaries are
 * computed, read by metrics and the viewer alike. A `final` request opens
 * its own entry (it reuses the last iteration number).
 */
export function iterationsOf(lines: TraceLine[]): Iteration[] {
  const out: Iteration[] = [];
  const byCall = new Map<string, IterationTool>();
  let current: Iteration | undefined;
  const open = (iteration: number, final: boolean): Iteration => {
    current = { iteration, final, tools: [], markers: [] };
    out.push(current);
    return current;
  };
  const at = (iteration: number | undefined): Iteration | undefined => {
    if (iteration === undefined) return current;
    if (current && current.iteration === iteration && !current.final) return current;
    return out.find((entry) => entry.iteration === iteration && !entry.final) ?? open(iteration, false);
  };

  for (const line of lines) {
    switch (line.type) {
      case 'llm_request': {
        const entry = line.final ? open(line.iteration, true) : at(line.iteration)!;
        entry.request = line as TraceLineOf<'llm_request'>;
        break;
      }
      case 'llm_response': {
        const entry = line.final ? (current?.final ? current : open(line.iteration, true)) : at(line.iteration)!;
        entry.response = line as TraceLineOf<'llm_response'>;
        break;
      }
      case 'system1_decision':
        at(line.iteration)!.system1 = line.decision;
        break;
      case 'tool_start': {
        const tool: IterationTool = {
          ...(line.toolCallId ? { toolCallId: line.toolCallId } : {}),
          name: line.toolName,
          stage: line.stage ?? legacyToolStage(line.toolName),
          args: line.args,
          ...(line.seq !== undefined ? { startSeq: line.seq } : {}),
        };
        at(line.iteration)!.tools.push(tool);
        if (line.toolCallId) byCall.set(line.toolCallId, tool);
        break;
      }
      case 'tool_complete': {
        const tool =
          (line.toolCallId && byCall.get(line.toolCallId)) ||
          at(line.iteration)?.tools.find((t) => t.name === line.toolName && t.durationMs === undefined);
        if (!tool) break;
        tool.durationMs = line.durationMs;
        tool.resultPreview = line.resultPreview;
        const outcome = line.outcome ?? legacyEditOutcome(line.toolName, line.resultPreview);
        if (outcome) tool.outcome = outcome;
        if (line.exitCode !== undefined) tool.exitCode = line.exitCode;
        break;
      }
      case 'tool_error': {
        const tool =
          (line.toolCallId && byCall.get(line.toolCallId)) ||
          at(line.iteration)?.tools.find((t) => t.name === line.toolName && t.outcome === undefined);
        if (tool) {
          tool.outcome = 'threw';
          tool.resultPreview = line.error;
        }
        break;
      }
      default:
        if (MARKERS.has(line.type)) {
          const iteration = (line as { iteration?: unknown }).iteration;
          (at(typeof iteration === 'number' ? iteration : undefined) ?? open(0, false)).markers.push(line);
        }
    }
  }
  return out;
}

/** Tool calls an iteration made, whether the model answered without tools, and plan-only. */
export function iterationShape(entry: Iteration): 'answer' | 'single' | 'multi' {
  return entry.tools.length === 0 ? 'answer' : entry.tools.length === 1 ? 'single' : 'multi';
}

export const PLAN_TOOLS = new Set(['plan', 'todo']);

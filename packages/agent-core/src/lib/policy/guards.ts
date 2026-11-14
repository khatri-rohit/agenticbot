import type { ToolStage } from '@agent/agent-models';

/**
 * What to do with a call that repeats an earlier one exactly (same tool,
 * same arguments), by its stage:
 * - exec (run_terminal) always runs: re-running a build after an edit is
 *   verification; identical outcomes are caught by the outcome guard.
 * - read and network change nothing, so past the limit the repeat is
 *   answered with a pointer to the earlier result (the harness acts, the
 *   run goes on); only past twice the limit (a model in a loop) does the
 *   run stop with a handoff.
 * - anything else (mutate, skill) stops the run past the limit.
 */
export function repeatAction(input: {
  /** Times this exact call has been made, this one included. */
  count: number;
  limit: number;
  stage: ToolStage;
}): 'run' | 'answer' | 'halt' {
  const { count, limit, stage } = input;
  if (count <= limit || stage === 'exec') return 'run';
  if ((stage === 'read' || stage === 'network') && count <= limit * 2) return 'answer';
  return 'halt';
}

/**
 * A run with a `report` tool keeps its last budgeted call for `report`:
 * once only that reserve is left, every other call is refused (a row, not a
 * halt), so the model still gets a turn to report.
 */
export function reportOnlyCall(input: {
  toolName: string;
  hasReport: boolean;
  maxToolCalls: number | undefined;
  used: number;
}): boolean {
  return (
    input.maxToolCalls !== undefined &&
    input.hasReport &&
    input.toolName !== 'report' &&
    input.used >= input.maxToolCalls - 1
  );
}

import { TASK_CLASS_MARKS, type TaskClass } from '@agent/agent-models';

export type TaskSize = {
  /** Model steps so far. */
  steps: number;
  /** Files with at least one successful edit. */
  editedFiles: number;
  /** Successful edits. */
  edits: number;
  /** Findings in the record (own and merged from sub-agents). */
  findings: number;
};

function reaches(size: TaskSize, marks: (typeof TASK_CLASS_MARKS)['medium' | 'long']): boolean {
  return (
    size.steps >= marks.steps ||
    size.editedFiles >= marks.editedFiles ||
    size.edits >= marks.edits ||
    size.findings >= marks.findings
  );
}

/**
 * Task class from evidence, for every shape: steps count for all, edits for
 * a change, findings for research. The caller only ever promotes.
 */
export function taskClassFor(size: TaskSize): TaskClass {
  if (reaches(size, TASK_CLASS_MARKS.long)) return 'long';
  if (reaches(size, TASK_CLASS_MARKS.medium)) return 'medium';
  return 'small';
}

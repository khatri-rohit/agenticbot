import { linesOf, type TraceLine } from '../read/trace.js';

/**
 * Harness health for one run: does each mechanism do what it exists for?
 * Phase 0 of the v2 build plan (docs/plans/harness-v2-build-plan.md). Pure,
 * from the trace alone; fields are null when the trace predates the event
 * they need.
 */
export type HealthMetrics = {
  /** Model calls this run made (own). */
  steps: number;
  /** Steps on which results were removed from the prompt, and their share of steps. */
  removalSteps: number;
  removalStepShare: number | null;
  /** From `context_shape`: residue (cards + old call arguments) as a share of the prompt. */
  residueShare: { mean: number; last: number } | null;
  /** Mean share of each call's messages that equal the previous call's leading messages. */
  prefixStability: number | null;
  /** Reads that returned a line range already returned, with no edit of that file between. */
  reReads: { reads: number; sameRange: number; rate: number | null };
  /** Re-reads of text that had been removed from the prompt (the model paid a step to get it back). */
  restores: number;
  /** Findings recorded with record_finding (research evidence). */
  findings: number;
  /** Identical searches (grep/glob, same arguments) with no edit between. */
  repeatSearches: { searches: number; repeats: number; rate: number | null };
  /** Repeated reads/fetches the guard answered instead of running or ending the run. */
  guardAnswered: number;
  /**
   * Card items (open items and advice): each first showing, and whether the
   * behaviour it asks for followed within ADVICE_WINDOW steps.
   */
  advice: {
    shown: number;
    followed: number;
    rate: number | null;
    byKind: Record<string, { shown: number; followed: number }>;
  };
  /**
   * Steps sent at low reasoning effort while making no progress (thrash at
   * low effort). Progress: a first read of a file, an edit, a command, a
   * delegate, or an answer; searches alone are not.
   */
  effortVsProgress: { lowEffortSteps: number; stepsWithoutProgress: number; lowEffortWithoutProgress: number };
  /** Child runs: the budget it was given and what it spent; null for a run with no `child_budget`. */
  childBudget: {
    maxPromptTokens: number;
    maxToolCalls: number;
    spentPromptTokens: number;
    toolCalls: number;
    within: boolean;
  } | null;
  /** Evidence units (successful edits, passing checks after edits, recorded findings) and total prompt tokens per unit. */
  evidence: number;
  costPerEvidence: number | null;
};

/** Steps after a card item first shows in which its behaviour counts as followed (incl. that step). */
export const ADVICE_WINDOW = 3;

const LOW_EFFORT = new Set(['none', 'minimal', 'low', 'off', 'false']);
const SEARCH_TOOLS = new Set(['grep', 'glob']);
const RANGE = /^\[lines (\d+)–(\d+) of (\d+)/;

type StepTool = { name: string; args: Record<string, unknown>; ok: boolean; exitCode?: number; preview: string };

function args(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function pathOf(value: Record<string, unknown>): string | undefined {
  return typeof value.path === 'string' ? value.path.replace(/\\/g, '/').replace(/^\.\//, '') : undefined;
}

function canonical(value: Record<string, unknown>): string {
  return JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key]]));
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);

/** Tools of each step (by iteration), in order, with their outcome. */
function toolsByStep(lines: TraceLine[]): Map<number, StepTool[]> {
  const starts = new Map<string, { iteration: number; name: string; args: Record<string, unknown> }>();
  for (const start of linesOf(lines, 'tool_start')) {
    if (!start.toolCallId) continue;
    starts.set(start.toolCallId, { iteration: start.iteration, name: start.toolName, args: args(start.args) });
  }
  const steps = new Map<number, StepTool[]>();
  for (const done of linesOf(lines, 'tool_complete')) {
    const start = done.toolCallId ? starts.get(done.toolCallId) : undefined;
    if (!start) continue;
    const list = steps.get(start.iteration) ?? [];
    list.push({
      name: start.name,
      args: start.args,
      ok: done.outcome !== 'error',
      ...(done.exitCode !== undefined ? { exitCode: done.exitCode } : {}),
      preview: done.resultPreview ?? '',
    });
    steps.set(start.iteration, list);
  }
  return steps;
}

const isEdit = (tool: StepTool) => tool.name === 'edit_file' && tool.ok && !/^(Error|oldText span)/.test(tool.preview);
const isCheck = (tool: StepTool) => tool.name === 'run_terminal' && tool.exitCode !== undefined;
const isPartialRead = (tool: StepTool) => {
  const range = RANGE.exec(tool.preview);
  return range !== null && (Number(range[1]) > 1 || Number(range[2]) < Number(range[3]));
};

/** Did the behaviour a card item asks for happen in these steps? */
function followed(id: string, window: StepTool[][], answered: boolean): boolean {
  const all = window.flat();
  if (id === 'advice:serial_reads') return window.some((step) => step.length >= 2);
  if (id.startsWith('advice:read_creep:')) {
    const path = id.slice('advice:read_creep:'.length);
    return !all.some((tool) => tool.name === 'read_file' && pathOf(tool.args) === path && isPartialRead(tool));
  }
  if (id === 'advice:stall') return answered || all.some(isEdit);
  if (id === 'advice:budget') return answered;
  if (id === 'advice:one_shot' || id === 'open:review') return all.some((tool) => tool.name === 'delegate');
  if (id === 'open:unchecked') return all.some(isCheck);
  if (id === 'open:check_failed') return all.some((tool) => isEdit(tool) || isCheck(tool));
  return false;
}

/** `advice:read_creep:src/a.ts` → `advice:read_creep`. */
function kindOf(id: string): string {
  const parts = id.split(':');
  return parts.slice(0, 2).join(':');
}

export function computeHealth(lines: TraceLine[], totalPromptTokens: number): HealthMetrics {
  const responses = linesOf(lines, 'llm_response');
  const steps = responses.length;
  const answeredAt = new Set(
    responses.filter((line) => !line.hasToolCalls).map((line) => line.iteration),
  );
  const byStep = toolsByStep(lines);
  const iterations = [...new Set([...responses.map((line) => line.iteration), ...byStep.keys()])].sort((a, b) => a - b);

  const removalSteps = new Set(linesOf(lines, 'context_evicted').map((line) => line.iteration)).size;

  const shapes = linesOf(lines, 'context_shape');
  const residues = shapes.filter((line) => line.promptTokens > 0).map((line) => line.residueTokens / line.promptTokens);
  let stableSum = 0;
  let stableCalls = 0;
  for (let i = 1; i < shapes.length; i++) {
    const before = shapes[i - 1]!.messages;
    if (before <= 0) continue;
    stableSum += Math.min(1, shapes[i]!.prefixStableMessages / before);
    stableCalls += 1;
  }

  // Re-reads and repeat searches, reset by an edit (of that file, or any edit for searches).
  const seenRanges = new Map<string, Set<string>>();
  const seenSearches = new Set<string>();
  let reads = 0;
  let sameRange = 0;
  let searches = 0;
  let repeats = 0;
  let evidence = 0;
  let findings = 0;
  let editedSinceCheck = false;
  const effort = new Map(linesOf(lines, 'llm_request').map((line) => [line.iteration, String(line.reasoningEffort ?? 'default')]));
  const touched = new Set<string>();
  let lowEffortSteps = 0;
  let stepsWithoutProgress = 0;
  let lowEffortWithoutProgress = 0;
  for (const iteration of iterations) {
    const tools = byStep.get(iteration) ?? [];
    let progress = answeredAt.has(iteration);
    for (const tool of tools) {
      const path = pathOf(tool.args);
      if (isEdit(tool)) {
        evidence += 1;
        editedSinceCheck = true;
        progress = true;
        if (path) seenRanges.delete(path);
        seenSearches.clear();
      } else if (isCheck(tool)) {
        progress = true;
        if (tool.exitCode === 0 && editedSinceCheck) evidence += 1;
        editedSinceCheck = false;
      } else if (tool.name === 'read_file' && path) {
        const range = RANGE.exec(tool.preview);
        if (!range) continue;
        reads += 1;
        const key = `${range[1]}-${range[2]}`;
        const seen = seenRanges.get(path) ?? new Set<string>();
        if (seen.has(key)) sameRange += 1;
        seen.add(key);
        seenRanges.set(path, seen);
        if (!touched.has(path)) progress = true;
        touched.add(path);
      } else if (SEARCH_TOOLS.has(tool.name)) {
        searches += 1;
        const key = `${tool.name}:${canonical(tool.args)}`;
        // A search is not progress on its own: rephrased searches for the
        // same thing are the thrash this measure exists to catch. What it
        // finds counts when the step reads, edits or answers.
        if (seenSearches.has(key)) repeats += 1;
        seenSearches.add(key);
      } else if (tool.name === 'delegate') {
        progress = true;
      } else if (tool.name === 'record_finding' && tool.preview.startsWith('Recorded')) {
        evidence += 1;
        findings += 1;
        progress = true;
      }
    }
    if (!responses.some((line) => line.iteration === iteration)) continue;
    const low = LOW_EFFORT.has(effort.get(iteration) ?? 'default');
    if (low) lowEffortSteps += 1;
    if (!progress) {
      stepsWithoutProgress += 1;
      if (low) lowEffortWithoutProgress += 1;
    }
  }

  // Advice: the first showing of each card item (or again after it went away).
  const byKind: Record<string, { shown: number; followed: number }> = {};
  let shown = 0;
  let followedCount = 0;
  let previous = new Set<string>();
  for (const card of linesOf(lines, 'policy_decision').filter((line) => line.kind === 'card')) {
    const current = new Set(card.ids);
    for (const id of current) {
      if (previous.has(id)) continue;
      const window = iterations
        .filter((iteration) => iteration >= card.iteration && iteration < card.iteration + ADVICE_WINDOW)
        .map((iteration) => byStep.get(iteration) ?? []);
      const answered = [...answeredAt].some(
        (iteration) => iteration >= card.iteration && iteration < card.iteration + ADVICE_WINDOW,
      );
      const ok = followed(id, window, answered);
      const kind = (byKind[kindOf(id)] ??= { shown: 0, followed: 0 });
      kind.shown += 1;
      shown += 1;
      if (ok) {
        kind.followed += 1;
        followedCount += 1;
      }
    }
    previous = current;
  }

  const budget = linesOf(lines, 'child_budget')[0];
  const finish = linesOf(lines, 'run_finish')[0];
  const spent = finish?.usage?.own.promptTokens ?? responses.reduce((sum, line) => sum + (line.usage?.promptTokens ?? 0), 0);
  const toolCalls = finish?.toolCalls ?? linesOf(lines, 'tool_start').length;

  return {
    steps,
    removalSteps,
    removalStepShare: ratio(removalSteps, steps),
    residueShare:
      residues.length > 0
        ? { mean: residues.reduce((sum, value) => sum + value, 0) / residues.length, last: residues.at(-1)! }
        : null,
    prefixStability: stableCalls > 0 ? stableSum / stableCalls : null,
    reReads: { reads, sameRange, rate: ratio(sameRange, reads) },
    restores: linesOf(lines, 'context_restored').length,
    findings,
    repeatSearches: { searches, repeats, rate: ratio(repeats, searches) },
    guardAnswered: linesOf(lines, 'policy_decision').filter((line) => line.kind === 'guard').length,
    advice: { shown, followed: followedCount, rate: ratio(followedCount, shown), byKind },
    effortVsProgress: { lowEffortSteps, stepsWithoutProgress, lowEffortWithoutProgress },
    childBudget: budget
      ? {
          maxPromptTokens: budget.maxPromptTokens,
          maxToolCalls: budget.maxToolCalls,
          spentPromptTokens: spent,
          toolCalls,
          within: toolCalls <= budget.maxToolCalls && spent <= budget.maxPromptTokens,
        }
      : null,
    evidence,
    costPerEvidence: evidence > 0 ? totalPromptTokens / evidence : null,
  };
}

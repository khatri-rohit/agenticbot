import { readFile, writeFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { RunMetrics } from '../metrics/run-metrics.js';

/**
 * A citation into a specific trace event. The viewer resolves these to
 * /runs/<runId>#seq-<seq>. Every hypothesis claim must have at least one.
 */
export type AnalystCitation = {
  runId: string;
  seq: number;
};

/**
 * A hypothesis about a class of failure, mapped to an owning layer.
 * Advisory only — never read by the gate.
 */
export type AnalystHypothesis = {
  claim: string;
  class: 'read-creep' | 'budget' | 'scope' | 'gate' | 'eval-task' | 'other';
  owningLayer:
    | 'limits'
    | 'context'
    | 'tools'
    | 'gates'
    | 'prompts'
    | 'model-map'
    | 'eval-task';
  citations: AnalystCitation[];
  proposedTasks: { taskId: string; rationale: string }[];
};

/**
 * Structured report from multi-trace synthesis. Stored in
 * evals/analyst/<id>.json. The gate never reads this path.
 */
export type AnalystReport = {
  id: string;
  inputs: { runId: string; threadId: string }[];
  hypotheses: AnalystHypothesis[];
  model: string;
  generatedAt: string;
};

/**
 * Read a single report.
 */
export async function readAnalystReport(
  evalsDir: string,
  id: string,
): Promise<AnalystReport | null> {
  const file = path.join(evalsDir, 'analyst', `${id}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as AnalystReport;
  } catch {
    return null;
  }
}

/**
 * List all report IDs.
 */
export async function listAnalystReports(evalsDir: string): Promise<string[]> {
  const dir = path.join(evalsDir, 'analyst');
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

/**
 * Validate a report: every hypothesis must have at least one citation.
 * Reports that fail validation are not written.
 */
function validateReport(report: AnalystReport): string[] {
  const errors: string[] = [];
  for (const h of report.hypotheses) {
    if (h.citations.length === 0) {
      errors.push(`hypothesis "${h.claim}" has no citations`);
    }
  }
  return errors;
}

/**
 * Generate an AnalystReport from failing traces + their metrics. This is the
 * only capacity-spending step in the eval pipeline (one synthesis call per
 * report). The model must differ from the agent model (same rule as E5
 * judges).
 *
 * This function produces the report structure. The actual LLM synthesis is
 * injected via `synthesize` so the library stays testable without a model.
 */
export async function generateAnalystReport(opts: {
  evalsDir: string;
  inputs: { runId: string; threadId: string; metrics: RunMetrics }[];
  model: string;
  synthesize: (input: {
    metrics: { runId: string; threadId: string; metrics: RunMetrics }[];
  }) => Promise<AnalystHypothesis[]>;
}): Promise<AnalystReport> {
  const id = `${Date.now()}-analyst`;
  const hypotheses = await opts.synthesize({
    metrics: opts.inputs.map((i) => ({
      runId: i.runId,
      threadId: i.threadId,
      metrics: i.metrics,
    })),
  });

  const report: AnalystReport = {
    id,
    inputs: opts.inputs.map((i) => ({ runId: i.runId, threadId: i.threadId })),
    hypotheses,
    model: opts.model,
    generatedAt: new Date().toISOString(),
  };

  const errors = validateReport(report);
  if (errors.length > 0) {
    throw new Error(`Analyst report validation failed: ${errors.join('; ')}`);
  }

  const file = path.join(opts.evalsDir, 'analyst', `${id}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  return report;
}
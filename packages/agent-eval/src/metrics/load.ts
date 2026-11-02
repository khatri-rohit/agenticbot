import type { LedgerEnvelope } from '@agent/agent-models';

import { readLedger } from '../read/ledger.js';
import type { RunSummary } from '../read/runs.js';
import { readRunTrace } from '../read/trace.js';
import { readUsage, type UsageRecord } from '../read/usage.js';
import { computeRunMetrics, type RunMetrics } from './run-metrics.js';

/** Depth-first: a run and all its sub-agent runs. */
export function flattenRuns(runs: RunSummary[]): RunSummary[] {
  return runs.flatMap((run) => [run, ...flattenRuns(run.children)]);
}

export function findRun(runs: RunSummary[], runId: string): RunSummary | undefined {
  return flattenRuns(runs).find((run) => run.runId === runId || run.runId.startsWith(runId));
}

/**
 * Read what metrics need from disk (trace, thread ledger, usage log) and
 * compute RunMetrics for each run. Ledgers and the usage log load once.
 */
export async function loadRunMetrics(home: string, runs: RunSummary[]): Promise<RunMetrics[]> {
  const usage: UsageRecord[] = (await readUsage(home)).records;
  const ledgers = new Map<string, LedgerEnvelope[]>();
  const out: RunMetrics[] = [];
  for (const run of runs) {
    let ledger = ledgers.get(run.threadId);
    if (!ledger) {
      ledger = (await readLedger(home, run.threadId)).envelopes;
      ledgers.set(run.threadId, ledger);
    }
    const { lines } = await readRunTrace(run.tracePath);
    out.push(computeRunMetrics({ run, lines, ledger, usage }));
  }
  return out;
}

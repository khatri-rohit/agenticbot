#!/usr/bin/env node
import { listRuns } from '../read/runs.js';
import { computeRunMetrics } from '../metrics/run-metrics.js';
import { readUsage } from '../read/usage.js';
import { generateAnalystReport } from '../analyst/generate.js';

const evalsDir = process.env.EVALS_DIR ?? './evals';
const home = process.env.AGENT_HOME ?? process.env.HOME ?? '.';
const runsArg = process.argv.find((a) => a.startsWith('--runs='))?.split('=')[1];
const suiteArg = process.argv.find((a) => a.startsWith('--suite='))?.split('=')[1];

if (!runsArg && !suiteArg) {
  console.error('Usage: analyst --runs=<id,...> | --suite=<label>');
  process.exit(1);
}

// Collect failing runs' metrics.
const allRuns = await listRuns(home);
const allUsage = await readUsage(home);

let targetRuns = allRuns;
if (runsArg) {
  const ids = runsArg.split(',');
  targetRuns = allRuns.filter((r) => ids.includes(r.runId));
}

const inputs = targetRuns.map((r) => {
  const u = allUsage.find((x) => x.runId === r.runId);
  return {
    runId: r.runId,
    threadId: r.threadId,
    metrics: computeRunMetrics(r, u),
  };
});

// The synthesize function is injected — in production this would call a
// model that differs from the agent model. For now, a stub that produces
// hypotheses from metrics patterns.
const report = await generateAnalystReport({
  evalsDir,
  inputs,
  model: process.env.EVAL_ANALYST_MODEL ?? 'analyst-model',
  synthesize: async ({ metrics }) => {
    return metrics.map((m) => {
      const isReadCreep = m.metrics.idleShare > 0.8 && m.metrics.toolHistogram.some(
        (t) => t.stage === 'read' && t.count > 10,
      );
      return {
        claim: isReadCreep
          ? `Run ${m.runId} spent ${(m.metrics.idleShare * 100).toFixed(0)}% of tokens before first edit with high read-tool usage`
          : `Run ${m.runId} has idle share ${(m.metrics.idleShare * 100).toFixed(0)}%`,
        class: isReadCreep ? 'read-creep' as const : 'budget' as const,
        owningLayer: isReadCreep ? 'context' as const : 'limits' as const,
        citations: [{ runId: m.runId, seq: m.metrics.firstEditAt?.seq ?? 0 }],
        proposedTasks: [],
      };
    });
  },
});

console.log(`Report ${report.id}: ${report.hypotheses.length} hypotheses`);
for (const h of report.hypotheses) {
  console.log(`  [${h.class}/${h.owningLayer}] ${h.claim}`);
  console.log(`    citations: ${h.citations.map((c) => `${c.runId.slice(0, 8)}#${c.seq}`).join(', ')}`);
}
console.log(`\nReport: ${evalsDir}/analyst/${report.id}.json`);
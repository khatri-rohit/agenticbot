#!/usr/bin/env node
import { readCatalog } from '../read/catalog.js';
import { listRuns } from '../read/runs.js';
import { computeRunMetrics } from '../metrics/run-metrics.js';
import { readUsage } from '../read/usage.js';

const home = process.env.AGENT_HOME ?? process.env.HOME ?? '.';
const filterThread = process.argv.find((a) => a.startsWith('--thread='))?.split('=')[1];
const json = process.argv.includes('--json');

const threads = readCatalog(home);
const usage = await readUsage(home);

const runs = await listRuns(home, filterThread ? { threadId: filterThread } : {});

if (json) {
  const out = runs.map((r) => {
    const u = usage.find((x) => x.runId === r.runId);
    return { ...r, metrics: computeRunMetrics(r, u), events: undefined };
  });
  console.log(JSON.stringify(out, null, 2));
} else {
  const cols = ['runId', 'thread', 'model', 'depth', 'status', 'limit', 'iter', 'tools', 'tokens', 'dur'];
  console.log(cols.join('\t'));
  for (const r of runs) {
    const u = usage.find((x) => x.runId === r.runId);
    const m = computeRunMetrics(r, u);
    console.log([
      r.runId.slice(0, 8),
      r.threadId.slice(0, 8),
      r.model,
      r.depth,
      r.status,
      r.limitReason ?? '-',
      r.iterations,
      r.toolCalls,
      m.promptTokens.total,
      `${(r.durationMs / 1000).toFixed(0)}s`,
    ].join('\t'));
  }
  console.log(`\n${threads.length} threads, ${runs.length} runs`);
}
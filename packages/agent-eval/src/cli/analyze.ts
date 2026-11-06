import path from 'node:path';

import { readSuiteRun } from '../gate/summary.js';
import { areaRows, signalsOf, type Unit } from '../metrics/areas.js';
import { flattenRuns, loadRunMetrics } from '../metrics/load.js';
import type { RunMetrics } from '../metrics/run-metrics.js';
import { listRuns } from '../read/runs.js';
import { agentHome, evalHome, flag, has, type Args } from './args.js';
import { percent, table, tokens } from './format.js';

export const ANALYZE_HELP = `analyze (--since <iso> | --thread <id> | --results <dir>) [--home <dir>] [--eval-home <dir>] [--json]
  Where the harness wastes or fails, by area: runs affected, their tokens, the worst signal, the module that owns the fix.
  --results reads a suite run's trials from the eval home; the others read real use from the agent home.`;

function show(unit: Unit, value: number): string {
  if (unit === 'share') return percent(value);
  if (unit === 'tokens') return tokens(value);
  if (unit === 'times') return `${value.toFixed(1)}×`;
  return String(value);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

async function selectRuns(args: Args): Promise<{ home: string; metrics: RunMetrics[] } | null> {
  const results = flag(args, 'results');
  if (results) {
    const home = evalHome(args);
    const suiteRun = await readSuiteRun(path.resolve(results));
    const runIds = new Set(suiteRun.results.flatMap((trial) => trial.runIds));
    const runs = flattenRuns(await listRuns(home)).filter(
      (run) => runIds.has(run.runId) || (run.parentRunId !== undefined && runIds.has(run.parentRunId)),
    );
    return { home, metrics: await loadRunMetrics(home, runs) };
  }
  const since = flag(args, 'since');
  const threadId = flag(args, 'thread');
  if (!since && !threadId) return null;
  const home = agentHome(args);
  const runs = flattenRuns(await listRuns(home, { ...(since ? { since } : {}), ...(threadId ? { threadId } : {}) }));
  return { home, metrics: await loadRunMetrics(home, runs) };
}

/** Share of all first-call prompt tokens by context layer, over the runs that report layers. */
function layerShares(list: RunMetrics[]): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const m of list) for (const [id, n] of Object.entries(m.firstCallLayers)) sums[id] = (sums[id] ?? 0) + n;
  const total = Object.values(sums).reduce((a, b) => a + b, 0);
  return Object.fromEntries(
    Object.entries(sums)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([id, n]) => [id, total > 0 ? n / total : 0]),
  );
}

/** The harness-plan scoreboard over a set of runs. */
function scoreboard(list: RunMetrics[]) {
  const firstCalls = list.map((m) => Object.values(m.firstCallLayers).reduce((a, b) => a + b, 0)).filter((v) => v > 0);
  const perCall = list.map((m) => m.promptPerCall?.median).filter((v): v is number => typeof v === 'number');
  const ratios = list.map((m) => m.promptToCompletion).filter((v): v is number => typeof v === 'number');
  const shape = list.reduce(
    (acc, m) => ({
      single: acc.single + m.callShape.single,
      all: acc.all + m.callShape.answer + m.callShape.single + m.callShape.multi,
      planOnly: acc.planOnly + m.callShape.planOnly,
    }),
    { single: 0, all: 0, planOnly: 0 },
  );
  return {
    runs: list.length,
    medianFirstCallPrompt: median(firstCalls),
    medianPromptPerCall: median(perCall),
    medianPromptToCompletion: median(ratios),
    oneToolIterationShare: shape.all > 0 ? shape.single / shape.all : null,
    planOnlyIterations: shape.planOnly,
    medianPromptGrowth: median(list.map((m) => m.promptGrowth).filter((v): v is number => v !== null)),
    runsWithUntracedCalls: list.filter((m) => m.untracedPromptTokens > 0).length,
    firstCallLayerShares: layerShares(list),
  };
}

export async function analyzeCommand(args: Args): Promise<number> {
  const selected = await selectRuns(args);
  if (!selected) {
    console.error(ANALYZE_HELP);
    return 1;
  }
  const { metrics } = selected;
  if (metrics.length === 0) {
    console.error('No runs match.');
    return 1;
  }
  const areas = areaRows(metrics);
  const board = scoreboard(metrics);
  const topRuns = [...metrics]
    .sort((a, b) => b.promptTokens.total - a.promptTokens.total)
    .slice(0, 10)
    .map((m) => ({ runId: m.runId, threadId: m.threadId, status: m.status, promptTokens: m.promptTokens.total, signals: signalsOf(m) }));

  if (has(args, 'json')) {
    console.log(JSON.stringify({ scoreboard: board, areas, topRuns }, null, 2));
    return 0;
  }

  console.log(
    table(
      ['area', 'runs', 'tokens in those runs', 'worst signal', 'owner'],
      areas.map((row) => [
        row.area,
        String(row.runs),
        tokens(row.tokens),
        row.worst
          ? `${row.worst.severity} · ${row.worst.signal} ${show(row.worst.unit, row.worst.value)} (≥ ${show(row.worst.unit, row.worst.threshold)})`
          : '-',
        row.owner,
      ]),
    ),
  );
  console.log(
    `\nScoreboard over ${board.runs} runs: first call median ${tokens(board.medianFirstCallPrompt ?? undefined)} (target ≤ 20k) · ` +
      `prompt per call median ${tokens(board.medianPromptPerCall ?? undefined)} (≤ 45k) · ` +
      `prompt:completion ${board.medianPromptToCompletion?.toFixed(0) ?? '-'}:1 (≤ 150) · ` +
      `one-tool iterations ${percent(board.oneToolIterationShare)} · plan-only ${board.planOnlyIterations} · ` +
      `prompt growth median ${board.medianPromptGrowth?.toFixed(1) ?? '-'}×`,
  );
  console.log(
    `First call by layer: ${Object.entries(board.firstCallLayerShares).slice(0, 6).map(([id, share]) => `${id} ${percent(share)}`).join(' · ') || '-'}`,
  );
  if (board.runsWithUntracedCalls > 0) {
    console.log(`Note: ${board.runsWithUntracedCalls} run(s) have prompt tokens in calls their trace does not show (older traces without the final call).`);
  }
  console.log('\nTop runs by tokens:');
  console.log(
    table(
      ['run', 'status', 'prompt', 'signals'],
      topRuns.map((run) => [
        run.runId,
        run.status,
        tokens(run.promptTokens),
        run.signals.map((s) => `${s.severity === 'bad' ? '!' : ''}${s.signal}`).join('; ') || '-',
      ]),
    ),
  );
  return 0;
}

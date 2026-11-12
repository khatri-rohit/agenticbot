import { findRun, flattenRuns, loadRunMetrics } from '../metrics/load.js';
import { signalsOf } from '../metrics/areas.js';
import type { RunMetrics } from '../metrics/run-metrics.js';
import { capacityRates, summarizeMetrics } from '../metrics/thread-metrics.js';
import { listRuns, stopLabel } from '../read/runs.js';
import { readUsage } from '../read/usage.js';
import { agentHome, flag, has, type Args } from './args.js';
import { duration, percent, table, tokens } from './format.js';

export const METRICS_HELP = `metrics (--run <id> | --thread <id> | --since <iso>) [--home <dir>] [--json]
  Per-run metrics from traces, ledger and usage log; a summary when several runs match.`;

function counts(map: Record<string, number>): string {
  return Object.entries(map).map(([key, n]) => `${key} ${n}`).join(', ') || '-';
}

function describeSystem1(s1: RunMetrics['system1']): string {
  if (!s1) return 'off (no System 1 lines)';
  return [
    `${s1.mode}, ${s1.decisions} decisions (applied ${s1.applied}, ${s1.mode === 'shadow' ? 'would change' : 'changed'} ${s1.changed})`,
    `calls ${s1.calls ?? '-'}`,
    `latency ${s1.latencyMs ? `p50 ${s1.latencyMs.p50}ms / p95 ${s1.latencyMs.p95}ms` : '-'}`,
    `fallbacks ${counts(s1.fallbacks)}`,
    `baseline→chosen ${counts(s1.transitions)}`,
  ].join('; ');
}

function describeHealth(h: RunMetrics['health']): string {
  const advice = Object.entries(h.advice.byKind)
    .map(([kind, n]) => `${kind} ${n.followed}/${n.shown}`)
    .join(', ');
  return [
    `health: removals on ${h.removalSteps}/${h.steps} steps (${percent(h.removalStepShare)})`,
    `residue ${h.residueShare ? `${percent(h.residueShare.mean)} mean, ${percent(h.residueShare.last)} last` : '-'}`,
    `prefix stable ${percent(h.prefixStability)}`,
    `same-range re-reads ${h.reReads.sameRange}/${h.reReads.reads} (${percent(h.reReads.rate)}), restores ${h.restores}`,
    `findings ${h.findings}`,
    `repeat searches ${h.repeatSearches.repeats}/${h.repeatSearches.searches}`,
    `repeats answered ${h.guardAnswered}`,
    `advice followed ${h.advice.followed}/${h.advice.shown}${advice ? ` (${advice})` : ''}`,
    `low effort without progress ${h.effortVsProgress.lowEffortWithoutProgress}/${h.effortVsProgress.stepsWithoutProgress} idle steps`,
    h.childBudget
      ? `child budget ${tokens(h.childBudget.spentPromptTokens)}/${tokens(h.childBudget.maxPromptTokens)}, calls ${h.childBudget.toolCalls}/${h.childBudget.maxToolCalls}${h.childBudget.within ? '' : ' OVER'}`
      : '',
    `evidence ${h.evidence}${h.costPerEvidence !== null ? ` (${tokens(h.costPerEvidence)} per unit)` : ''}`,
  ]
    .filter(Boolean)
    .join('; ');
}

function describe(m: RunMetrics): string {
  const lines = [
    `run ${m.runId} (thread ${m.threadId})  ${m.model ?? ''}`,
    `status ${m.status}${m.limitReason ? ` — ${m.limitReason}` : ''}`,
    `iterations ${m.iterations}, tool calls ${m.toolCalls} (network ${m.networkCalls})`,
    `prompt ${tokens(m.promptTokens.total)} (own ${tokens(m.promptTokens.own)}, sub-agents ${tokens(m.promptTokens.children)}, share ${percent(m.childShare)})`,
    m.promptPerCall
      ? `per call: median ${tokens(m.promptPerCall.median)}, p90 ${tokens(m.promptPerCall.p90)}, max ${tokens(m.promptPerCall.max)} over ${m.promptPerCall.calls} calls`
      : 'per call: no provider usage',
    `prompt:completion ${m.promptToCompletion?.toFixed(0) ?? '-'}:1`,
    `wall clock ${duration(m.wallClockMs)}${m.runDurationMs !== undefined ? ` (answer footer ${duration(m.runDurationMs)}, last call ${duration(m.answerWriteMs)})` : ''}`,
    `edits ${m.edits}${m.firstEdit ? `, first at iteration ${m.firstEdit.iteration} after ${tokens(m.firstEdit.promptTokensBefore)}` : ''}; idle share ${percent(m.idleShare)}`,
    `read walks: ${m.readWalks.length ? m.readWalks.map((w) => `${w.path} ×${w.calls} (it ${w.fromIteration}–${w.toIteration})`).join('; ') : 'none'}`,
    `re-reads after eviction: ${m.reReadsAfterEviction ?? 'n/a (trace predates eviction ids)'} (recall ${m.recallCalls})`,
    `steering: stall ${m.steering.stallNudges}, research gate ${m.steering.researchGates}, notes ${m.steering.toolNotes}, budget warnings ${m.steering.budgetWarnings}, evictions ${m.steering.evictions}, in-run compactions ${m.steering.inRunCompactions}, prefix heavy ${m.steering.prefixHeavy}, thread compactions ${m.steering.threadCompactions}`,
    `limits: ${m.steering.limits.join(' | ') || 'none'}`,
    describeHealth(m.health),
    `tools: ${Object.entries(m.toolsByName).sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ${n}`).join(', ')}`,
    `phases: ${m.phases ? `before first edit ${tokens(m.phases.beforeFirstEdit)}, editing ${tokens(m.phases.editing)}, after last edit ${tokens(m.phases.afterLastEdit)}; checked by a command after the last edit: ${m.verifiedAfterEdit ? 'yes' : 'no'}` : 'no edits'}`,
    `calls: ${m.callShape.answer} answers, ${m.callShape.single} one-tool (${m.callShape.planOnly} plan-only), ${m.callShape.multi} multi-tool; prompt growth ${m.promptGrowth?.toFixed(1) ?? '-'}×${m.untracedPromptTokens > 0 ? ` (${tokens(m.untracedPromptTokens)} of prompt in calls this trace does not show: an older trace without its final call)` : ''}`,
    `first call by layer: ${counts(Object.fromEntries(Object.entries(m.firstCallLayers).filter(([, n]) => n > 0).map(([k, n]) => [k, n])))}`,
    `time: model ${duration(m.time.modelMs)}, tools ${m.time.toolSeconds}s (parallel tools overlap)`,
    `tool outcomes: ${Object.entries(m.toolOutcomes).filter(([, o]) => o.errors > 0 || o.nonZeroExit > 0).map(([name, o]) => `${name} ${o.errors}/${o.calls} failed${o.nonZeroExit ? `, ${o.nonZeroExit} non-zero exits` : ''}`).join('; ') || 'no failures recorded'}`,
    `signals: ${signalsOf(m).map((s) => `${s.severity} ${s.area}: ${s.signal}`).join('; ') || 'none'}`,
    `skills: loaded ${m.skills.loaded} (~${tokens(m.skills.loadedTokens)}), retired ${m.skills.evicted}`,
    `memory gate: ${counts(m.memoryGate)}`,
    `reasoning effort: ${counts(m.reasoningEffort)}`,
    `system 1: ${describeSystem1(m.system1)}`,
    `capacity: ${m.capacity ? `weekly ${m.capacity.weeklyPercent}%, session ${m.capacity.sessionPercent}%` : 'no usage row'}`,
  ];
  return lines.join('\n');
}

export async function metricsCommand(args: Args): Promise<number> {
  const home = agentHome(args);
  const runId = flag(args, 'run');
  const threadId = flag(args, 'thread');
  const since = flag(args, 'since');
  if (!runId && !threadId && !since) {
    console.error(METRICS_HELP);
    return 1;
  }
  const roots = await listRuns(home, {
    ...(threadId ? { threadId } : {}),
    ...(since ? { since } : {}),
  });
  const selected = runId ? [findRun(roots, runId)].filter((run) => run !== undefined) : flattenRuns(roots);
  if (selected.length === 0) {
    console.error(`No run matches${runId ? ` ${runId}` : ''}.`);
    return 1;
  }
  const list = await loadRunMetrics(home, selected);
  if (has(args, 'json')) {
    console.log(JSON.stringify(list.length === 1 ? list[0] : { runs: list, summary: summarizeMetrics(list) }, null, 2));
    return 0;
  }
  if (list.length === 1) {
    console.log(describe(list[0]!));
    return 0;
  }
  console.log(
    table(
      ['run', 'status', 'iters', 'prompt', 'median/call', 'edits', 'idle', 'walks', 'net', 'stall', 'limit'],
      list.map((m) => [
        m.runId.slice(0, 8),
        m.status,
        String(m.iterations),
        tokens(m.promptTokens.total),
        tokens(m.promptPerCall?.median),
        String(m.edits),
        percent(m.idleShare),
        String(m.readWalks.length),
        String(m.networkCalls),
        String(m.steering.stallNudges),
        stopLabel(m.limitReason),
      ]),
    ),
  );
  const summary = summarizeMetrics(list);
  console.log(
    `\n${summary.runs} runs, ${tokens(summary.promptTokens)} prompt tokens, ${summary.edits} edits, median idle share ${percent(summary.medianIdleShare)}, ${summary.readWalks} read walks`,
  );
  if (Object.keys(summary.memoryGate).length > 0) console.log(`memory gate: ${counts(summary.memoryGate)}`);
  if (summary.system1) {
    const s1 = summary.system1;
    console.log(
      `system 1: ${s1.runs} runs (${counts(s1.modes)}), ${s1.decisions} decisions, applied ${s1.applied}, changed ${s1.changed}, fallbacks ${s1.fallbacks}`,
    );
  }
  const rates = capacityRates((await readUsage(home)).records);
  for (const rate of rates) {
    console.log(
      `capacity ${rate.model}: ${rate.weeklyPercentPer1M.toFixed(2)}% of the week per 1M prompt tokens (${rate.runs} runs)`,
    );
  }
  return 0;
}

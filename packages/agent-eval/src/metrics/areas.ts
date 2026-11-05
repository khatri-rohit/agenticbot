import { isPauseStop, isResumableStop } from '@agent/agent-models';

import type { RunMetrics } from './run-metrics.js';

/** Where a waste or failure lives, so a finding points at the code that owns the fix. */
export type Area =
  | 'context'
  | 'exploration'
  | 'batching'
  | 'tools'
  | 'verification'
  | 'steering'
  | 'budget'
  | 'system1';

export const AREA_OWNERS: Record<Area, string> = {
  context: 'agent-core context/ (residency, compaction, assembly)',
  exploration: 'agent-core prompts/ + tools/workspace (read guidance)',
  batching: 'agent-core prompts/system-prompt.ts + loop (parallel calls)',
  tools: 'agent-core tools/ (the failing tool)',
  verification: 'agent-core prompts/ (verify after editing)',
  steering: 'agent-core loop/progress-steering.ts',
  budget: 'agent-core loop/run-budget.ts + limits.ts',
  system1: 'agent-core system1/ + SYSTEMONE_* settings',
};

export type Unit = 'tokens' | 'share' | 'count' | 'times';

type Rule = {
  area: Area;
  signal: string;
  unit: Unit;
  /** null: the rule does not apply to this run. */
  value: (m: RunMetrics) => number | null;
  warnAt: number;
  badAt: number;
};

const share = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const calls = (m: RunMetrics) => m.callShape.answer + m.callShape.single + m.callShape.multi;
const sumLayers = (m: RunMetrics) => Object.values(m.firstCallLayers).reduce((a, b) => a + b, 0);
const toolErrors = (m: RunMetrics) => Object.values(m.toolOutcomes).reduce((a, o) => a + o.errors, 0);
const toolCalls = (m: RunMetrics) => Object.values(m.toolOutcomes).reduce((a, o) => a + o.calls, 0);

/**
 * The one threshold table (targets from the harness plan: first call ≤ 20k,
 * median per call ≤ 45k). A rule fires at `warnAt`, and is bad at `badAt`.
 */
export const RULES: Rule[] = [
  { area: 'context', signal: 'median prompt per call', unit: 'tokens', value: (m) => m.promptPerCall?.median ?? null, warnAt: 45_000, badAt: 100_000 },
  { area: 'context', signal: 'prompt growth (last ÷ first call)', unit: 'times', value: (m) => m.promptGrowth, warnAt: 3, badAt: 10 },
  { area: 'context', signal: 'first call prompt', unit: 'tokens', value: (m) => (sumLayers(m) > 0 ? sumLayers(m) : null), warnAt: 20_000, badAt: 40_000 },
  { area: 'context', signal: 'prefix too heavy to compact', unit: 'count', value: (m) => m.steering.prefixHeavy, warnAt: 1, badAt: 3 },
  {
    area: 'exploration',
    signal: 'share of tokens before the first edit', unit: 'share',
    value: (m) => (m.phases ? share(m.phases.beforeFirstEdit, m.phases.beforeFirstEdit + m.phases.editing + m.phases.afterLastEdit) : null),
    warnAt: 0.5,
    badAt: 0.8,
  },
  { area: 'exploration', signal: 'read walks', unit: 'count', value: (m) => m.readWalks.length, warnAt: 1, badAt: 3 },
  { area: 'batching', signal: 'one-tool iterations', unit: 'share', value: (m) => (calls(m) >= 4 ? share(m.callShape.single, calls(m)) : null), warnAt: 0.5, badAt: 0.75 },
  { area: 'batching', signal: 'plan-only iterations', unit: 'count', value: (m) => m.callShape.planOnly, warnAt: 1, badAt: 3 },
  { area: 'tools', signal: 'failed edits', unit: 'count', value: (m) => m.toolOutcomes.edit_file?.errors ?? null, warnAt: 1, badAt: 3 },
  { area: 'tools', signal: 'tool failure rate', unit: 'share', value: (m) => share(toolErrors(m), toolCalls(m)), warnAt: 0.1, badAt: 0.25 },
  { area: 'verification', signal: 'edits never checked by a command', unit: 'count', value: (m) => (m.verifiedAfterEdit === false ? 1 : null), warnAt: 1, badAt: 2 },
  { area: 'steering', signal: 'stall nudges', unit: 'count', value: (m) => m.steering.stallNudges, warnAt: 1, badAt: 3 },
  { area: 'steering', signal: 'research gates', unit: 'count', value: (m) => m.steering.researchGates, warnAt: 1, badAt: 3 },
  {
    area: 'budget',
    signal: 'stopped at a limit', unit: 'count',
    value: (m) => (m.limitReason && isResumableStop(m.limitReason) && !isPauseStop(m.limitReason) ? 1 : null),
    warnAt: 1,
    badAt: 1,
  },
  {
    area: 'system1',
    signal: 'System 1 fallback rate', unit: 'share',
    value: (m) => (m.system1 && m.system1.decisions > 0 ? Object.values(m.system1.fallbacks).reduce((a, b) => a + b, 0) / m.system1.decisions : null),
    warnAt: 0.1,
    badAt: 0.5,
  },
];

export type Signal = { area: Area; signal: string; unit: Unit; severity: 'warn' | 'bad'; value: number; threshold: number };

/** The rules a run trips, worst first. */
export function signalsOf(m: RunMetrics): Signal[] {
  const out: Signal[] = [];
  for (const rule of RULES) {
    const value = rule.value(m);
    if (value === null || value < rule.warnAt) continue;
    const bad = value >= rule.badAt;
    out.push({ area: rule.area, signal: rule.signal, unit: rule.unit, severity: bad ? 'bad' : 'warn', value, threshold: bad ? rule.badAt : rule.warnAt });
  }
  return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'bad' ? -1 : 1));
}

export type AreaRow = {
  area: Area;
  owner: string;
  /** Runs that tripped at least one rule of the area. */
  runs: number;
  /** Prompt tokens (own + sub-agents) of those runs: where the area's cost sits. */
  tokens: number;
  worst: Signal | null;
};

/** One row per area, most tokens first: the next thing to improve is the top row. */
export function areaRows(list: RunMetrics[]): AreaRow[] {
  const rows = new Map<Area, AreaRow>();
  for (const area of Object.keys(AREA_OWNERS) as Area[]) {
    rows.set(area, { area, owner: AREA_OWNERS[area], runs: 0, tokens: 0, worst: null });
  }
  for (const m of list) {
    const signals = signalsOf(m);
    for (const area of new Set(signals.map((s) => s.area))) {
      const row = rows.get(area)!;
      row.runs += 1;
      row.tokens += m.promptTokens.total;
      for (const s of signals.filter((x) => x.area === area)) {
        const worse = !row.worst || (s.severity === 'bad' && row.worst.severity === 'warn') ||
          (s.severity === row.worst.severity && s.value / s.threshold > row.worst.value / row.worst.threshold);
        if (worse) row.worst = s;
      }
    }
  }
  return [...rows.values()].sort((a, b) => b.tokens - a.tokens || b.runs - a.runs);
}

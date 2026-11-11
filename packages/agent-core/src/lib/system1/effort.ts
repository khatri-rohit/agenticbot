import {
  SYSTEM1_AUTO_THINKING,
  type OllamaModelConfig,
  type System1EffortTrace,
  type System1Question,
  type System1Scores,
  type ThinkingValue,
} from '@agent/agent-models';

import { resolveReasoningEffort } from '../model/ollama-model-config';
import type { System1Port } from './port';

/** One thinking choice the model itself offers, lowest first. */
export type EffortRung = {
  /** Stable label: `off`, `on`, or the model's level string. */
  key: string;
  value: ThinkingValue;
  /** reasoning_effort the harness sends for this choice. */
  wire: string;
};

/**
 * `fixed`: one wire value every iteration (user pick, or no usable ladder).
 * A ladder on a fixed policy lets shadow mode observe without applying.
 * `auto`: System 1 may move between rungs (enforce mode only).
 */
export type EffortPolicy =
  | { kind: 'fixed'; wire?: string; ladder?: EffortRung[]; baselineIndex?: number }
  | { kind: 'auto'; ladder: EffortRung[]; baselineIndex: number };

/**
 * Only used to sort the levels a model lists. A level not in this list makes
 * the ladder unrankable and the router stays off for that model: an unknown
 * vendor level is never guessed into place.
 */
const LEVEL_RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Ordered thinking choices from the model's own /api/show values, or null
 * when there is nothing to choose between (no thinking, one rung, unknown
 * level names, or choices that collapse to the same wire value).
 */
export function buildEffortLadder(config: OllamaModelConfig): EffortRung[] | null {
  const { thinking } = config;
  if (!thinking.supported) return null;

  const candidates: Array<{ key: string; value: ThinkingValue; rank: number }> = [];
  for (const value of thinking.values) {
    if (value === false) candidates.push({ key: 'off', value, rank: -1 });
    else if (value === true) {
      // `true` means "the default level" on a model that also lists levels.
      if (thinking.mode === 'boolean') candidates.push({ key: 'on', value, rank: 0 });
    } else {
      const rank = LEVEL_RANK.indexOf(value);
      if (rank < 0) return null;
      candidates.push({ key: value, value, rank });
    }
  }
  candidates.sort((a, b) => a.rank - b.rank);

  const ladder: EffortRung[] = [];
  for (const candidate of candidates) {
    const wire = resolveReasoningEffort(config, candidate.value);
    if (wire === undefined || ladder.some((rung) => rung.wire === wire)) continue;
    ladder.push({ key: candidate.key, value: candidate.value, wire });
  }
  return ladder.length >= 2 ? ladder : null;
}

/** True when the model's own values already include `auto` (its choice, not ours). */
export function modelOwnsAuto(config: OllamaModelConfig): boolean {
  return config.thinking.values.includes(SYSTEM1_AUTO_THINKING);
}

/**
 * Policy for one run. `requested` is the client's pick; `autoEnabled` says
 * whether System 1 enforce is available for this run.
 */
export function buildEffortPolicy(
  config: OllamaModelConfig | null,
  requested: ThinkingValue | undefined,
  autoEnabled: boolean,
): EffortPolicy {
  if (!config) return { kind: 'fixed' };
  const wantsAuto = requested === SYSTEM1_AUTO_THINKING && !modelOwnsAuto(config);
  const pick = wantsAuto ? undefined : requested;
  const wire = resolveReasoningEffort(config, pick);
  const ladder = buildEffortLadder(config);
  const baselineIndex = ladder?.findIndex((rung) => rung.wire === wire) ?? -1;

  if (!ladder || baselineIndex < 0) return { kind: 'fixed', ...(wire !== undefined ? { wire } : {}) };
  if (wantsAuto && autoEnabled) return { kind: 'auto', ladder, baselineIndex };
  // Explicit pick, or Auto without enforce (stale client): fixed at that value.
  return { kind: 'fixed', ...(wire !== undefined ? { wire } : {}), ladder, baselineIndex };
}

/** Wire value sent when System 1 does not change anything. */
export function baselineWire(policy: EffortPolicy | undefined): string | undefined {
  if (!policy) return undefined;
  return policy.kind === 'auto' ? policy.ladder[policy.baselineIndex]!.wire : policy.wire;
}

export type ProfileThinking = 'off' | 'default' | 'max';

/**
 * Sub-agent thinking resolved against the child model's own values:
 * `off` only if that model offers off, `max` = its highest rung, otherwise
 * the model's default (undefined).
 */
export function resolveProfileThinking(
  config: OllamaModelConfig | null,
  preference: ProfileThinking,
): ThinkingValue | undefined {
  if (!config?.thinking.supported || preference === 'default') return undefined;
  if (preference === 'off') return config.thinking.values.includes(false) ? false : undefined;
  const ladder = buildEffortLadder(config);
  return ladder ? ladder[ladder.length - 1]!.value : undefined;
}

/** Loop facts the rules read; reset after every decision. */
export type EffortSignals = {
  iteration: number;
  /** Newest message is role user: the user's prompt or a loop nudge. */
  steering: boolean;
  toolError: boolean;
  /** edit_file, run_terminal or delegate ran since the last call. */
  wrote: boolean;
};

export type EffortThresholds = {
  /** Raise to a rung when P(needs ≥ rung) is at least this. */
  raise: number;
  /** Lower only when P(needs ≥ baseline) is at most this. */
  lower: number;
  /** A lower rung is kept when P(needs ≥ it) is at least this. */
  keep: number;
  /** Allowed rise in P between higher rungs before scores count as inconsistent. */
  monotoneTolerance: number;
};

export const DEFAULT_EFFORT_THRESHOLDS: EffortThresholds = {
  raise: 0.6,
  lower: 0.1,
  keep: 0.5,
  monotoneTolerance: 0.1,
};

/** Lowest rung the rules allow this iteration, and why. */
export function ruleFloor(
  signals: EffortSignals,
  baselineIndex: number,
): { index: number; reason: string } {
  if (signals.iteration <= 1) return { index: baselineIndex, reason: 'first_turn' };
  if (signals.toolError) return { index: baselineIndex, reason: 'tool_error' };
  if (signals.wrote) return { index: baselineIndex, reason: 'write_or_exec' };
  if (signals.steering) return { index: baselineIndex, reason: 'steering' };
  return { index: 0, reason: 'none' };
}

function questionKey(rung: EffortRung): string {
  return `needs_at_least_${rung.key}`;
}

/**
 * Ordinal questions over the model's own ladder: "needs at least rung i?"
 * for every rung above the lowest. One request carries all of them.
 */
export function buildEffortQuestions(ladder: EffortRung[]): Record<string, System1Question> {
  const lowest = ladder[0]!.key;
  const highest = ladder[ladder.length - 1]!.key;
  const questions: Record<string, System1Question> = {};
  ladder.slice(1).forEach((rung, offset) => {
    const below = ladder[offset]!.key;
    questions[questionKey(rung)] = {
      type: 'noul',
      instructions: `A coding agent is about to take its next step. Its reasoning effort options run from "${lowest}" (lowest) to "${highest}" (highest). Does the next step need at least "${rung.key}"?`,
      criteria: {
        true: `The next step is hard enough that "${below}" risks a wrong plan, a wrong edit, or a missed detail: it involves design choices, unclear errors, several files, or a final answer.`,
        false: `"${below}" is enough: the next step is routine, such as reading the results it just asked for or making an obvious follow-up call.`,
      },
    };
  });
  return questions;
}

export type RungChoice = {
  index: number;
  reason: string;
  /** Scores allowed a lower rung this time (hysteresis input for the next call). */
  lowerEligible: boolean;
};

/**
 * Pick a rung from scores. Raises apply at once; a lower needs two eligible
 * iterations in a row and never goes below the rules' floor.
 */
export function chooseRung(
  ladder: EffortRung[],
  baselineIndex: number,
  floorIndex: number,
  scores: System1Scores,
  previousLowerEligible: boolean,
  thresholds: EffortThresholds = DEFAULT_EFFORT_THRESHOLDS,
): RungChoice | { inconsistent: string } {
  // P(needs ≥ lowest rung) is 1 by definition.
  const p = ladder.map((rung, index) => (index === 0 ? 1 : scores[questionKey(rung)]));
  for (let i = 1; i < p.length; i++) {
    if (p[i] === undefined) return { inconsistent: `no score for ${ladder[i]!.key}` };
    if (p[i]! > p[i - 1]! + thresholds.monotoneTolerance) {
      return { inconsistent: `P(≥${ladder[i]!.key})=${p[i]!.toFixed(2)} above P(≥${ladder[i - 1]!.key})=${p[i - 1]!.toFixed(2)}` };
    }
  }

  for (let i = ladder.length - 1; i > baselineIndex; i--) {
    if (p[i]! >= thresholds.raise) return { index: i, reason: 'raise', lowerEligible: false };
  }

  if (baselineIndex > floorIndex && p[baselineIndex]! <= thresholds.lower) {
    let target = floorIndex;
    for (let i = baselineIndex - 1; i > floorIndex; i--) {
      if (p[i]! >= thresholds.keep) {
        target = i;
        break;
      }
    }
    if (!previousLowerEligible) return { index: baselineIndex, reason: 'lower_pending', lowerEligible: true };
    return { index: target, reason: 'lower', lowerEligible: true };
  }

  return { index: baselineIndex, reason: 'keep', lowerEligible: false };
}

/** Quiet iterations between System 1 asks while nothing changes (enforce). */
export const EFFORT_ASK_EVERY = 3;

export type EffortDecision = {
  /** reasoning_effort to send; undefined = send none (today's behaviour for that model). */
  wire?: string;
  /** True when `wire` differs from the policy's baseline. */
  applied: boolean;
  /** Present for decisions made inline (enforce, fixed, fallback). */
  trace?: System1EffortTrace;
};

export type EffortRouterInput = {
  policy: EffortPolicy | undefined;
  system1: System1Port | undefined;
  signals: EffortSignals;
  /** Built lazily: only when a call is made. */
  state: () => string;
  signal?: AbortSignal;
  /** Shadow decisions, traced when they land. */
  onTrace: (trace: System1EffortTrace) => void;
};

/**
 * Per-run effort router. `decide` never throws. In enforce, a call with no
 * answer (budget spent, breaker, timeout) holds System 1's last answer, floored
 * by this iteration's rules; before any answer, or on an internal error, it
 * returns the baseline, which is exactly what the run sends without System 1.
 */
export function createEffortRouter() {
  let lowerEligible = false;
  let shadowLowerEligible = false;
  /** Enforce only: the rung System 1's last real answer chose (before any floor). */
  let lastScoredIndex: number | null = null;
  /** Enforce only: when the last call was made, whether it was quiet, and its outcome. */
  let lastAsk: { iteration: number; quiet: boolean; reason: string } | null = null;

  async function decide(input: EffortRouterInput): Promise<EffortDecision> {
    const { policy, system1, signals } = input;
    const baseline = baselineWire(policy);
    const keepBaseline = (): EffortDecision => ({
      ...(baseline !== undefined ? { wire: baseline } : {}),
      applied: false,
    });
    if (!policy) return keepBaseline();

    try {
      if (!system1 || !policy.ladder || policy.baselineIndex === undefined) return keepBaseline();
      const ladder = policy.ladder;
      const baselineIndex = policy.baselineIndex;
      // Auto only acts in enforce; everything else at most observes in shadow.
      const enforce = policy.kind === 'auto' && system1.mode === 'enforce';
      if (!enforce && system1.mode !== 'shadow') return keepBaseline();

      const floor = ruleFloor(signals, baselineIndex);
      // Already at the top and the rules forbid lowering: nothing can change.
      if (baselineIndex === ladder.length - 1 && floor.index >= baselineIndex) return keepBaseline();

      const run = async (previousLowerEligible: boolean) => {
        const started = Date.now();
        const scores = await system1.ask('effort', input.state(), buildEffortQuestions(ladder), {
          iteration: signals.iteration,
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const latencyMs = Date.now() - started;
        const base: System1EffortTrace = {
          mode: system1.mode,
          baseline: ladder[baselineIndex]!.wire,
          applied: false,
          reason: 'fallback',
          floor: ladder[floor.index]!.key,
          latencyMs,
        };
        if (!scores) return { trace: { ...base, chosen: base.baseline }, index: baselineIndex, lowerEligible: false };
        const choice = chooseRung(ladder, baselineIndex, floor.index, scores, previousLowerEligible);
        if ('inconsistent' in choice) {
          system1.note('effort', 'inconsistent', signals.iteration, choice.inconsistent);
          return { trace: { ...base, chosen: base.baseline, reason: 'inconsistent', scores }, index: baselineIndex, lowerEligible: false };
        }
        const chosen = ladder[choice.index]!.wire;
        return {
          trace: { ...base, chosen, reason: choice.reason, scores },
          index: choice.index,
          lowerEligible: choice.lowerEligible,
        };
      };

      if (!enforce) {
        // Shadow: never blocks the model call; the decision is traced when it lands.
        system1.track(
          run(shadowLowerEligible).then(
            (result) => {
              shadowLowerEligible = result.lowerEligible;
              input.onTrace(result.trace);
            },
            (error: unknown) =>
              system1.note('effort', 'internal', signals.iteration, error instanceof Error ? error.message : String(error)),
          ),
        );
        return keepBaseline();
      }

      // Cadence: ask at events, not every iteration. A quiet iteration (no
      // first turn, error, write, or instruction) right after a quiet,
      // settled answer holds that answer without a call; the budget then
      // lasts the whole run. lower_pending is never settled: its confirming
      // ask must come next.
      const quiet = floor.reason === 'none';
      if (
        lastScoredIndex !== null &&
        lastAsk !== null &&
        quiet &&
        lastAsk.quiet &&
        lastAsk.reason !== 'lower_pending' &&
        signals.iteration - lastAsk.iteration < EFFORT_ASK_EVERY
      ) {
        const heldIndex = Math.max(lastScoredIndex, floor.index);
        const wire = ladder[heldIndex]!.wire;
        const applied = wire !== baseline;
        if (applied) system1.markApplied();
        return {
          wire,
          applied,
          trace: {
            mode: system1.mode,
            baseline: ladder[baselineIndex]!.wire,
            chosen: wire,
            applied,
            reason: 'cadence_hold',
            floor: ladder[floor.index]!.key,
          },
        };
      }

      const result = await run(lowerEligible);
      lastAsk = { iteration: signals.iteration, quiet, reason: result.trace.reason };
      let index = result.index;
      let trace = result.trace;
      if (result.trace.reason === 'fallback') {
        // No opinion this time (budget spent, breaker open, timeout, busy):
        // hold System 1's last answer instead of reverting to the baseline,
        // so a long run does not spend its tail at the user's top rung. The
        // rules' floor still wins for this iteration (errors, writes, new
        // instructions), and hysteresis state is untouched (no new evidence).
        if (lastScoredIndex !== null) {
          index = Math.max(lastScoredIndex, floor.index);
          trace = { ...trace, chosen: ladder[index]!.wire, reason: 'held' };
        }
      } else {
        lowerEligible = result.lowerEligible;
        if (result.trace.reason !== 'inconsistent') lastScoredIndex = result.index;
      }
      const wire = ladder[index]!.wire;
      const applied = wire !== baseline;
      if (applied) system1.markApplied();
      return { wire, applied, trace: { ...trace, applied } };
    } catch (error) {
      system1?.note('effort', 'internal', signals.iteration, error instanceof Error ? error.message : String(error));
      return keepBaseline();
    }
  }

  return { decide };
}

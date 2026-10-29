import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type {
  OllamaBalance,
  OllamaBalanceLegacy,
  OllamaBalanceModern,
  RunUsage,
} from '@agent/agent-models';
import { nativeOllamaBaseUrl, type CapacityGate } from '@agent/agent-core';

/**
 * Ollama Cloud capacity: the cached balance, an even-weekly-pace governor
 * the loop reads synchronously, and a usage log that pairs each run's tokens
 * with the balance before and after (to learn % of the week per 1M tokens).
 *
 * Process-wide on purpose: every thread and sub-agent spends one account.
 */

/** 60s TTL keeps us under the balance API's 10 requests/minute. */
const BALANCE_TTL_MS = 60_000;
/** Floor between forced refreshes (after a run, after a 429). */
const BALANCE_MIN_REFRESH_MS = 10_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;
/** Even pacing aims to reach the weekly reset with this much left (%). */
const PACE_RESERVE_PERCENT = 5;
/** Conserve when this many points behind the even-pace line. */
const PACE_BEHIND_POINTS = 10;
/** Conserve at or below this remaining share, whatever the pace (%). */
const LOW_PERCENT = 15;
/** At or below this remaining share the account is treated as spent (%). */
const PAUSE_PERCENT = 1;

type RawBalanceIncluded = {
  balance_usd?: number;
  allowance_usd?: number;
  period?: { from?: string; until?: string };
  session?: { remaining_percent?: number; resets_at?: string };
  weekly?: { remaining_percent?: number; resets_at?: string };
};

type RawBalanceResponse = {
  included?: RawBalanceIncluded;
  purchased?: { balance_usd?: number };
};

export function parseBalance(raw: RawBalanceResponse): OllamaBalance {
  const included = raw.included ?? {};
  const result: OllamaBalance = {};

  if (included.session && included.weekly) {
    const legacy: OllamaBalanceLegacy = {
      session: {
        remainingPercent: included.session.remaining_percent ?? 0,
        resetsAt: included.session.resets_at ?? '',
      },
      weekly: {
        remainingPercent: included.weekly.remaining_percent ?? 0,
        resetsAt: included.weekly.resets_at ?? '',
      },
    };
    result.legacy = legacy;
  } else if (
    typeof included.balance_usd === 'number' &&
    typeof included.allowance_usd === 'number'
  ) {
    const modern: OllamaBalanceModern = {
      balanceUsd: included.balance_usd,
      allowanceUsd: included.allowance_usd,
      period: {
        from: included.period?.from ?? '',
        until: included.period?.until ?? '',
      },
    };
    result.modern = modern;
  }

  if (typeof raw.purchased?.balance_usd === 'number') {
    result.purchasedUsd = raw.purchased.balance_usd;
  }

  return result;
}

export class BalanceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'BalanceError';
  }
}

let cache: { data: OllamaBalance; fetchedAt: number } | null = null;
let inflight: Promise<OllamaBalance> | null = null;
/** Last request start, success or failure: failures back off like successes. */
let lastAttemptAt = 0;

export function capacityEnabled(): boolean {
  return Boolean(process.env.OLLAMA_API_KEY);
}

async function fetchBalance(): Promise<OllamaBalance> {
  const base = nativeOllamaBaseUrl('cloud');
  const response = await fetch(`${base}/api/balance`, {
    headers: { Authorization: `Bearer ${process.env.OLLAMA_API_KEY}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new BalanceError(
      response.status,
      `Ollama balance API returned ${response.status}`,
    );
  }
  const raw = (await response.json().catch(() => ({}))) as RawBalanceResponse;
  const data = parseBalance(raw);
  cache = { data, fetchedAt: Date.now() };
  return data;
}

/**
 * Cached balance. `maxAgeMs` below the TTL forces a refresh, but never more
 * often than BALANCE_MIN_REFRESH_MS. Concurrent callers share one request.
 */
export async function getOllamaBalance(
  maxAgeMs = BALANCE_TTL_MS,
): Promise<OllamaBalance> {
  const now = Date.now();
  const age = cache ? now - cache.fetchedAt : Infinity;
  if (cache && (age < maxAgeMs || age < BALANCE_MIN_REFRESH_MS)) return cache.data;
  // Forced refreshes (after a run, after a 429) also respect the floor when
  // the previous attempt failed, so errors cannot turn into a request storm.
  if (!inflight && cache && now - lastAttemptAt < BALANCE_MIN_REFRESH_MS) {
    return cache.data;
  }
  if (!inflight) {
    lastAttemptAt = now;
    inflight = fetchBalance().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * Last known balance without waiting; kicks a background refresh when stale.
 * Refreshes wait BALANCE_TTL_MS after the last attempt, so a failing balance
 * API (no cache ever filled) is not retried on every model call.
 */
function cachedBalance(): OllamaBalance | null {
  const now = Date.now();
  if (
    capacityEnabled() &&
    !inflight &&
    (!cache || now - cache.fetchedAt >= BALANCE_TTL_MS) &&
    now - lastAttemptAt >= BALANCE_TTL_MS
  ) {
    void getOllamaBalance().catch(() => undefined);
  }
  return cache?.data ?? null;
}

export type CapacityState = 'open' | 'conserve' | 'pause';

export type CapacityAdvice = {
  state: CapacityState;
  /** Human reason for conserve/pause (shown as the run's limit reason). */
  reason?: string;
};

function formatReset(iso: string): string {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  return ` (resets ${new Date(at).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })})`;
}

/** A window whose reset time has passed says nothing about now. */
function current(limit: { remainingPercent: number; resetsAt: string }, now: number) {
  const reset = Date.parse(limit.resetsAt);
  return Number.isFinite(reset) && reset <= now ? null : limit;
}

/**
 * Points the account is behind an even spend line that starts the period at
 * 100% and reaches PACE_RESERVE_PERCENT at the reset. Positive = spending
 * faster than the week allows.
 */
function pointsBehind(
  remainingPercent: number,
  periodEnd: number,
  periodMs: number,
  now: number,
): number {
  if (!Number.isFinite(periodEnd) || periodMs <= 0) return 0;
  const left = Math.min(1, Math.max(0, (periodEnd - now) / periodMs));
  const expected = PACE_RESERVE_PERCENT + (100 - PACE_RESERVE_PERCENT) * left;
  return expected - remainingPercent;
}

/** Pure: what the governor says for a balance at a moment. */
export function capacityAdvice(
  balance: OllamaBalance | null,
  now = Date.now(),
): CapacityAdvice {
  if (!balance) return { state: 'open' };

  if (balance.legacy) {
    const session = current(balance.legacy.session, now);
    const weekly = current(balance.legacy.weekly, now);
    if (session && session.remainingPercent <= PAUSE_PERCENT) {
      return {
        state: 'pause',
        reason: `Ollama session usage limit reached${formatReset(session.resetsAt)}`,
      };
    }
    if (weekly && weekly.remainingPercent <= PAUSE_PERCENT) {
      return {
        state: 'pause',
        reason: `Ollama weekly usage limit reached${formatReset(weekly.resetsAt)}`,
      };
    }
    const behind = weekly
      ? pointsBehind(weekly.remainingPercent, Date.parse(weekly.resetsAt), WEEK_MS, now)
      : 0;
    if (weekly && (weekly.remainingPercent <= LOW_PERCENT || behind > PACE_BEHIND_POINTS)) {
      return {
        state: 'conserve',
        reason: `weekly ${Math.round(weekly.remainingPercent)}% left, ${Math.round(behind)} points behind even pace`,
      };
    }
    if (session && session.remainingPercent <= LOW_PERCENT) {
      return {
        state: 'conserve',
        reason: `session ${Math.round(session.remainingPercent)}% left`,
      };
    }
    return { state: 'open' };
  }

  if (balance.modern && balance.modern.allowanceUsd > 0) {
    const { balanceUsd, allowanceUsd, period } = balance.modern;
    const purchased = balance.purchasedUsd ?? 0;
    if (balanceUsd <= 0 && purchased <= 0) {
      return {
        state: 'pause',
        reason: `Ollama included usage spent${formatReset(period.until)}`,
      };
    }
    // Purchased credit is extra headroom; pace only the included allowance.
    if (purchased > 0) return { state: 'open' };
    const remainingPercent = (balanceUsd / allowanceUsd) * 100;
    const end = Date.parse(period.until);
    const start = Date.parse(period.from);
    const behind = pointsBehind(remainingPercent, end, end - start, now);
    if (remainingPercent <= LOW_PERCENT || behind > PACE_BEHIND_POINTS) {
      return {
        state: 'conserve',
        reason: `$${balanceUsd.toFixed(2)} of $${allowanceUsd.toFixed(2)} left, ${Math.round(behind)} points behind even pace`,
      };
    }
  }
  return { state: 'open' };
}

/** "429 … reached your session usage limit …" → which limit, else null. */
function usageLimitKind(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!/usage limit/i.test(message)) return null;
  if (/weekly/i.test(message)) return 'weekly';
  if (/session/i.test(message)) return 'session';
  return 'account';
}

/**
 * The loop's view of capacity. Reads only the cache (refreshes in the
 * background), so a run never waits on the balance API.
 */
export function createCapacityGate(): CapacityGate {
  return {
    pauseReason() {
      const advice = capacityAdvice(cachedBalance());
      return advice.state === 'pause' ? (advice.reason ?? 'usage limit reached') : null;
    },
    conserve() {
      return capacityAdvice(cachedBalance()).state === 'conserve';
    },
    limitReasonFor(error) {
      const kind = usageLimitKind(error);
      if (!kind) return null;
      // The cached balance predates the 429; fetch the reset time for next time.
      void getOllamaBalance(0).catch(() => undefined);
      const balance = cache?.data.legacy;
      const reset =
        kind === 'weekly'
          ? balance?.weekly.resetsAt
          : kind === 'session'
            ? balance?.session.resetsAt
            : undefined;
      return `Ollama ${kind} usage limit reached${reset ? formatReset(reset) : ''}`;
    },
  };
}

/** Current governor state from the cache (no network wait). Open when capacity is off. */
export function capacityState(): CapacityState {
  return capacityEnabled() ? capacityAdvice(cachedBalance()).state : 'open';
}

/** Compact balance for the usage log. */
function balancePoint(balance: OllamaBalance | null) {
  if (balance?.legacy) {
    return {
      sessionRemainingPercent: balance.legacy.session.remainingPercent,
      weeklyRemainingPercent: balance.legacy.weekly.remainingPercent,
    };
  }
  if (balance?.modern) {
    return {
      balanceUsd: balance.modern.balanceUsd,
      allowanceUsd: balance.modern.allowanceUsd,
      ...(balance.purchasedUsd !== undefined ? { purchasedUsd: balance.purchasedUsd } : {}),
    };
  }
  return null;
}

/** Balance at run start, for the usage log (no network). */
export function capacitySnapshot() {
  return balancePoint(cachedBalance());
}

/**
 * One line per finished run in `$AGENT_HOME/usage/usage.jsonl`: tokens (own +
 * sub-agents) next to the balance before and after. Balance percentages are
 * whole numbers and shared with other clients, so a single row is noisy;
 * the rate comes from many rows. Best-effort: never fails a run.
 */
export async function appendUsageLog(
  home: string,
  entry: {
    runId: string;
    threadId: string;
    model: string;
    endpoint: string;
    status: string;
    limitReason?: string;
    usage?: RunUsage;
    balanceBefore: ReturnType<typeof balancePoint>;
  },
): Promise<void> {
  try {
    let after: OllamaBalance | null = null;
    if (entry.endpoint === 'cloud' && capacityEnabled()) {
      after = await getOllamaBalance(0).catch(() => cache?.data ?? null);
    }
    const dir = path.join(home, 'usage');
    await mkdir(dir, { recursive: true });
    await appendFile(
      path.join(dir, 'usage.jsonl'),
      `${JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
        balanceAfter: balancePoint(after),
        capacity: capacityAdvice(after).state,
      })}\n`,
      'utf8',
    );
  } catch (error) {
    console.error(
      'usage log append failed:',
      error instanceof Error ? error.message : error,
    );
  }
}

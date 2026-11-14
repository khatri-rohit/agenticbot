import {
  buildEffortLadder,
  callSystem1,
  createSystem1Port,
  modelOwnsAuto,
  System1Health,
  type System1ClientConfig,
  type System1Port,
} from '@agent/agent-core';
import type {
  OllamaEndpoint,
  OllamaModelConfig,
  System1Mode,
} from '@agent/agent-models';

/**
 * Host wiring for System 1, from env:
 * - OLLAMA_SYSTEMONE_URL   endpoint; unset = disabled everywhere
 * - SYSTEMONE_MODEL        scorer model (default nimble-v3:9b)
 * - SYSTEMONE_MODE         off | shadow | enforce (default enforce: Auto is offered,
 *                          and only runs where the user picks Auto change)
 * - SYSTEMONE_TIMEOUT_MS   per-call timeout (default 5000)
 * - SYSTEMONE_WITH_LOCAL   1 = also on local-endpoint runs (shares the daemon's VRAM)
 */
type System1Settings = {
  client: System1ClientConfig;
  mode: System1Mode;
  withLocal: boolean;
};

const DEFAULT_MODEL = 'nimble-v3:9b';
const DEFAULT_TIMEOUT_MS = 5000;
/** Per-run ceiling on System 1 wall time, before the share of maxWallMs. */
const RUN_BUDGET_CAP_MS = 60_000;
const RUN_BUDGET_SHARE = 0.05;

// One daemon serves every run: breaker and in-flight limit are process-wide.
const health = new System1Health();
let cached: System1Settings | null | undefined;

function parseMode(raw: string | undefined): System1Mode {
  const value = raw?.trim().toLowerCase();
  if (!value) return 'enforce';
  if (value === 'off' || value === 'shadow' || value === 'enforce')
    return value;
  console.warn(
    `[system1] SYSTEMONE_MODE="${raw}" is not off|shadow|enforce; using enforce`,
  );
  return 'enforce';
}

function parseTimeout(raw: string | undefined): number {
  const value = Number(raw);
  return Number.isFinite(value) && value >= 50
    ? Math.floor(value)
    : DEFAULT_TIMEOUT_MS;
}

export function system1Settings(): System1Settings | null {
  if (cached !== undefined) return cached;
  const url = process.env.OLLAMA_SYSTEMONE_URL?.trim();
  const mode = parseMode(process.env.SYSTEMONE_MODE);
  if (!url || mode === 'off') {
    cached = null;
    return cached;
  }
  cached = {
    client: {
      url,
      model: process.env.SYSTEMONE_MODEL?.trim() || DEFAULT_MODEL,
      timeoutMs: parseTimeout(process.env.SYSTEMONE_TIMEOUT_MS),
    },
    mode,
    withLocal: process.env.SYSTEMONE_WITH_LOCAL === '1',
  };
  return cached;
}

/** Local runs share the daemon's VRAM with the scorer: off unless opted in. */
function allowedFor(
  settings: System1Settings,
  endpoint: OllamaEndpoint,
): boolean {
  return endpoint === 'cloud' || settings.withLocal;
}

/** A fresh port for one run, or undefined (never consulted). */
export function system1PortForRun(
  endpoint: OllamaEndpoint,
  maxWallMs: number,
): System1Port | undefined {
  const settings = system1Settings();
  if (!settings || settings.mode === 'off' || !allowedFor(settings, endpoint))
    return undefined;
  const runBudgetMs = Math.min(RUN_BUDGET_CAP_MS, maxWallMs * RUN_BUDGET_SHARE);
  return createSystem1Port({
    client: settings.client,
    health,
    mode: settings.mode,
    runBudgetMs,
  });
}

/** System 1 may apply effort decisions on this endpoint (Auto is meaningful). */
export function system1EnforceAvailable(endpoint: OllamaEndpoint): boolean {
  const settings = system1Settings();
  return Boolean(
    settings && settings.mode === 'enforce' && allowedFor(settings, endpoint),
  );
}

/** Offer "Auto" in the thinking picker for this model and endpoint. */
export function system1AutoFor(
  endpoint: OllamaEndpoint,
  config: OllamaModelConfig,
): boolean {
  return (
    system1EnforceAvailable(endpoint) &&
    !modelOwnsAuto(config) &&
    buildEffortLadder(config) !== null
  );
}

/**
 * Boot: log the setup, warn when user text would leave this machine, and
 * load the scorer so the first real call is not a cold start.
 */
export function initSystem1(): void {
  const settings = system1Settings();
  if (!settings) {
    console.log(
      '[system1] disabled (OLLAMA_SYSTEMONE_URL unset or SYSTEMONE_MODE=off)',
    );
    return;
  }
  const { client, mode } = settings;
  console.log(
    `[system1] ${mode} · ${client.model} · timeout ${client.timeoutMs}ms`,
  );
  try {
    const host = new URL(client.url).hostname;
    if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) {
      console.warn(
        `[system1] OLLAMA_SYSTEMONE_URL points at ${host}: run state (task text, tool names) is sent there`,
      );
    }
  } catch {
    console.warn(
      `[system1] OLLAMA_SYSTEMONE_URL is not a valid URL; every call will fall back`,
    );
  }
  void callSystem1({ ...client, timeoutMs: 60_000 }, 'warm-up', {
    ready: {
      type: 'noul',
      instructions: 'Is this a warm-up request?',
      criteria: { true: 'It is a warm-up request.', false: 'It is not.' },
    },
  }).then((result) => {
    if (result.ok) console.log(`[system1] warm in ${result.latencyMs}ms`);
    else
      console.warn(
        `[system1] warm-up failed (${result.kind}): ${result.detail} — runs continue without it`,
      );
  });
}

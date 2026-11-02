import type {
  System1FallbackKind,
  System1Question,
  System1Scores,
} from '@agent/agent-models';

export type System1ClientConfig = {
  /** Full endpoint URL (OLLAMA_SYSTEMONE_URL). */
  url: string;
  /** Scorer model id (SYSTEMONE_MODEL). */
  model: string;
  timeoutMs: number;
};

/** `cancelled` = the run was aborted; never recorded as a failure. */
export type System1CallResult =
  | { ok: true; scores: System1Scores; latencyMs: number }
  | {
      ok: false;
      kind: Extract<System1FallbackKind, 'unreachable' | 'timeout' | 'http_error' | 'bad_response'> | 'cancelled';
      detail: string;
      latencyMs: number;
    };

type FetchFn = typeof fetch;

const DETAIL_MAX = 200;

function clip(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate a response against the questions asked. Every asked key must come
 * back with the asked type and a finite score in [0, 1]; anything else is
 * `bad_response` (partial answers are not used).
 */
export function parseSystem1Response(
  body: unknown,
  questions: Record<string, System1Question>,
  model: string,
): { ok: true; scores: System1Scores } | { ok: false; detail: string } {
  if (!isRecord(body)) return { ok: false, detail: 'response is not a JSON object' };
  if (typeof body['model'] === 'string' && body['model'] !== model) {
    return { ok: false, detail: `model mismatch: asked ${model}, got ${body['model']}` };
  }
  const answers = body['answers'];
  if (!isRecord(answers)) return { ok: false, detail: 'response has no answers object' };
  const scores: System1Scores = {};
  for (const [key, question] of Object.entries(questions)) {
    const answer = answers[key];
    if (!isRecord(answer)) return { ok: false, detail: `missing answer for ${key}` };
    if (answer['type'] !== question.type) {
      return { ok: false, detail: `answer ${key} has type ${String(answer['type'])}, asked ${question.type}` };
    }
    const value = answer[question.type];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      return { ok: false, detail: `answer ${key} score is not in [0, 1]: ${String(value)}` };
    }
    scores[key] = value;
  }
  return { ok: true, scores };
}

/**
 * One POST to the System 1 endpoint. Never throws: every failure comes back
 * as a kind the caller records and falls back on.
 */
export async function callSystem1(
  config: System1ClientConfig,
  state: string,
  questions: Record<string, System1Question>,
  signal?: AbortSignal,
  fetchImpl: FetchFn = fetch,
): Promise<System1CallResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  if (signal?.aborted) return { ok: false, kind: 'cancelled', detail: 'run cancelled', latencyMs: 0 };

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetchImpl(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, state, questions }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, kind: 'http_error', detail: clip(`HTTP ${res.status}: ${text}`), latencyMs: elapsed() };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, kind: 'bad_response', detail: clip(`invalid JSON: ${text}`), latencyMs: elapsed() };
    }
    const parsed = parseSystem1Response(body, questions, config.model);
    if (!parsed.ok) return { ok: false, kind: 'bad_response', detail: clip(parsed.detail), latencyMs: elapsed() };
    return { ok: true, scores: parsed.scores, latencyMs: elapsed() };
  } catch (error) {
    if (signal?.aborted) return { ok: false, kind: 'cancelled', detail: 'run cancelled', latencyMs: elapsed() };
    if (timedOut) {
      return { ok: false, kind: 'timeout', detail: `no answer within ${config.timeoutMs}ms`, latencyMs: elapsed() };
    }
    const message = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    return { ok: false, kind: 'unreachable', detail: clip(message), latencyMs: elapsed() };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';

import {
  isWorkspaceKind,
  type OllamaEndpoint,
  type ResolvedModelSettings,
  type SideCallThinking,
} from '@agent/agent-models';
import {
  buildReviewMessages,
  gateMemoryOps,
  getClient,
  getOllamaModelConfig,
  newUserTurns,
  parseReviewProposals,
  sideCallReasoningEffort,
} from '@agent/agent-core';

import { sideCallBudget } from '../models/model-settings-store';
import { getAgentHome, getMemoryStore, getThreadStore, runManager } from '../platform/instances';

/**
 * Learning loop: once a thread has been idle for a while, a side model reads
 * its new turns and proposes durable memory. Every proposal that passes the
 * gate is staged; nothing is written until the user approves it in Settings.
 * Off the request path; failures only log.
 */

const DEFAULT_IDLE_MS = 10 * 60_000;
const MIN_NEW_USER_TURNS = 2;

const timers = new Map<string, NodeJS.Timeout>();

function idleMs(): number {
  const raw = Number(process.env.AGENT_LEARNING_IDLE_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IDLE_MS;
}

function reviewedPath(threadId: string): string {
  return path.join(getAgentHome(), 'learning', `${threadId}.json`);
}

async function readReviewedSeq(threadId: string): Promise<number> {
  try {
    const raw = JSON.parse(await readFile(reviewedPath(threadId), 'utf8')) as { throughSeq?: unknown };
    return typeof raw.throughSeq === 'number' ? raw.throughSeq : 0;
  } catch {
    return 0;
  }
}

async function writeReviewedSeq(threadId: string, throughSeq: number): Promise<void> {
  const target = reviewedPath(threadId);
  await mkdir(path.dirname(target), { recursive: true });
  // Atomic like every other store: a crash mid-write must not reset the
  // cursor to 0 and re-review the whole thread.
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ throughSeq }), 'utf8');
  await rename(tmp, target);
}

/**
 * The review model from the run's resolved settings (file > env > thread's
 * model). Falls back to the thread's own model when no snapshot was passed.
 */
function reviewModelFor(
  model: string,
  modelSettings: ResolvedModelSettings | undefined,
): string {
  const summary = modelSettings?.roles.summary;
  return summary && summary.source !== 'default' ? summary.model : model;
}

/** Thinking preference mapped onto the model's own values (off = pre-settings behavior). */
async function reviewThinking(
  model: string,
  endpoint: OllamaEndpoint,
  thinking: SideCallThinking,
): Promise<string | undefined> {
  try {
    const config = await getOllamaModelConfig(model, endpoint);
    return sideCallReasoningEffort(config, thinking);
  } catch {
    return undefined;
  }
}

async function reviewThread(input: {
  threadId: string;
  model: string;
  endpoint: OllamaEndpoint;
  modelSettings?: ResolvedModelSettings;
}): Promise<void> {
  const store = await getThreadStore();
  const thread = store.getThread(input.threadId);
  // Sub-agent threads are the parent's work, not the user's conversation.
  if (!thread || thread.parentThreadId) return;
  const afterSeq = await readReviewedSeq(input.threadId);
  const envelopes = await store.readLedger(input.threadId, 0);
  const lastSeq = envelopes.at(-1)?.seq ?? 0;
  if (lastSeq <= afterSeq || newUserTurns(envelopes, afterSeq) < MIN_NEW_USER_TURNS) return;

  const workspaceRoot = isWorkspaceKind(thread.kind) ? thread.workspaceRoot : undefined;
  const memory = getMemoryStore();
  const files = await memory.read(workspaceRoot);
  const model = reviewModelFor(input.model, input.modelSettings);
  const thinking = input.modelSettings?.thinking.learningReview ?? 'off';
  const reasoningEffort = await reviewThinking(model, input.endpoint, thinking);
  const budget = sideCallBudget(thinking);
  const completion = await getClient(input.endpoint).chat.completions.create(
    {
      model,
      messages: buildReviewMessages({ envelopes, afterSeq, memory: files }),
      max_tokens: budget.maxTokens,
      temperature: 0.2,
      ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    } as ChatCompletionCreateParamsNonStreaming,
    { signal: AbortSignal.timeout(budget.timeoutMs) },
  );
  const proposals = parseReviewProposals(completion.choices[0]?.message?.content ?? '', {
    threadId: input.threadId,
    seq: lastSeq,
  });

  // The gate still rules out secrets, duplicates and over-cap writes; what
  // it would apply or stage is staged here, never applied.
  const pending = await memory.listPending();
  const gated = gateMemoryOps(files, proposals);
  let staged = 0;
  for (const result of gated) {
    if (result.verdict === 'reject') continue;
    const content = result.op.content?.trim();
    if (pending.some((op) => op.content?.trim() === content)) continue;
    await memory.stage(result.op, workspaceRoot);
    staged += 1;
  }
  await writeReviewedSeq(input.threadId, lastSeq);
  if (staged > 0) {
    console.info(`[learning] ${input.threadId}: ${staged} memory suggestion(s) staged for approval`);
  }
}

/** After a rewind: turns past `keepThroughSeq` are gone, so the review cursor steps back. */
export async function rewindLearningCursor(threadId: string, keepThroughSeq: number): Promise<void> {
  const reviewed = await readReviewedSeq(threadId);
  if (reviewed > keepThroughSeq) await writeReviewedSeq(threadId, keepThroughSeq);
}

/**
 * Call after a run settles. Restarts the thread's idle timer; when it fires
 * with no run active on the thread, the review runs.
 */
export function scheduleLearningReview(input: {
  threadId: string;
  model: string;
  endpoint: OllamaEndpoint;
  enabled: boolean;
  modelSettings?: ResolvedModelSettings;
}): void {
  if (!input.enabled) return;
  const existing = timers.get(input.threadId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    timers.delete(input.threadId);
    if (runManager.activeRun(input.threadId)) {
      scheduleLearningReview(input);
      return;
    }
    reviewThread(input).catch((error: unknown) => {
      console.warn(
        `[learning] review of ${input.threadId} failed:`,
        error instanceof Error ? error.message : error,
      );
    });
  }, idleMs());
  // Never keeps the process alive on shutdown.
  timer.unref();
  timers.set(input.threadId, timer);
}

/**
 * Call when a thread is deleted: drop its pending review timer so it cannot
 * fire against a deleted thread's ledger.
 */
export function cancelLearningReview(threadId: string): void {
  const timer = timers.get(threadId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(threadId);
  }
}

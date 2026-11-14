import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  emptyThreadPlan,
  isThreadPlanEmpty,
  parseThreadPlan,
  planHasOpenWork,
  planTodoCounts,
  type LedgerEnvelope,
  type ReviewDigest,
  type ReviewFinding,
  type ReviewFingerprint,
  type ReviewNumbers,
  type ThreadPlan,
} from '@agent/agent-models';

import { readCatalog } from '../read/catalog.js';
import { readLedger } from '../read/ledger.js';
import { flattenRuns, loadRunMetrics } from '../metrics/load.js';
import { signalsOf } from '../metrics/areas.js';
import type { RunMetrics } from '../metrics/run-metrics.js';
import { listRuns, type RunSummary } from '../read/runs.js';

export type ReviewExcerpt = { source: string; text: string };

export type ReviewModelInput = {
  digest: ReviewDigest;
  excerpts: ReviewExcerpt[];
};

export type ThreadReviewAnalysis = {
  fingerprint: ReviewFingerprint;
  digest: ReviewDigest;
  excerpts: ReviewExcerpt[];
};

const ASK_RE =
  /^(what|why|how|when|where|who|which|explain|summarize|describe)\b|\?$/i;
const CHANGE_RE =
  /\b(fix|implement|add|change|edit|refactor|update|write|create|delete|remove|patch)\b/i;
const EXCERPT_MAX = 400;
const EXCERPT_LIMIT = 5;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function shaOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function texts(envelopes: LedgerEnvelope[], role: 'user' | 'assistant'): string[] {
  const out: string[] = [];
  for (const envelope of envelopes) {
    if (envelope.record.role !== role) continue;
    const content = envelope.record.content;
    if (typeof content === 'string' && content.trim()) out.push(content.trim());
  }
  return out;
}

function lastAssistant(envelopes: LedgerEnvelope[]): string {
  for (let i = envelopes.length - 1; i >= 0; i -= 1) {
    const envelope = envelopes[i];
    if (!envelope) continue;
    const record = envelope.record;
    if (record.role === 'assistant' && typeof record.content === 'string' && record.content.trim()) {
      return record.content.trim();
    }
  }
  return '';
}

async function readPlan(home: string, threadId: string): Promise<ThreadPlan> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(path.join(home, 'sessions', threadId, 'plan.json'), 'utf8'),
    );
    return parseThreadPlan(raw, threadId);
  } catch {
    return emptyThreadPlan(threadId);
  }
}

/** Parent thread when this id is a sub-agent; the catalog is optional (run pages still work). */
export function reviewOwnerThread(
  home: string,
  threadId: string,
): { threadId: string; title: string; model: string } {
  const catalog = existsSync(path.join(home, 'catalog.db')) ? readCatalog(home) : [];
  const row = catalog.find((thread) => thread.id === threadId);
  const id = row?.parentThreadId ?? threadId;
  const owner = catalog.find((thread) => thread.id === id) ?? row;
  return { threadId: id, title: owner?.title ?? id, model: owner?.model ?? '' };
}

/** Stable key for `reviews/<threadId>.json`. Unchanged → reuse the stored artifact. */
export function reviewFingerprint(input: {
  threadId: string;
  ledger: LedgerEnvelope[];
  runs: Array<{ runId: string; status: string }>;
}): ReviewFingerprint {
  const last = input.ledger.at(-1);
  return {
    threadId: input.threadId,
    ledgerLength: input.ledger.length,
    lastRecordSha: last ? shaOf(last) : '',
    runs: [...input.runs]
      .map((run) => ({ runId: run.runId, status: run.status }))
      .sort((a, b) => a.runId.localeCompare(b.runId)),
  };
}

function numbersOf(metrics: RunMetrics[]): ReviewNumbers {
  const calls = metrics.reduce(
    (sum, m) => sum + m.callShape.answer + m.callShape.single + m.callShape.multi,
    0,
  );
  const single = metrics.reduce((sum, m) => sum + m.callShape.single, 0);
  const ownPrompt = metrics.reduce((sum, m) => sum + m.promptTokens.own, 0);
  const childPrompt = metrics.reduce((sum, m) => sum + m.promptTokens.children, 0);
  const totalPrompt = ownPrompt + childPrompt;
  return {
    runs: metrics.length,
    completed: metrics.filter((m) => m.status === 'completed').length,
    iterations: metrics.reduce((sum, m) => sum + m.iterations, 0),
    toolCalls: metrics.reduce((sum, m) => sum + m.toolCalls, 0),
    promptTokens: ownPrompt,
    completionTokens: metrics.reduce((sum, m) => sum + m.completionTokens.own, 0),
    edits: metrics.reduce((sum, m) => sum + m.edits, 0),
    failedEdits: metrics.reduce((sum, m) => sum + (m.toolOutcomes.edit_file?.errors ?? 0), 0),
    oneToolShare: calls >= 4 ? single / calls : null,
    planOnly: metrics.reduce((sum, m) => sum + m.callShape.planOnly, 0),
    readWalks: metrics.reduce((sum, m) => sum + m.readWalks.length, 0),
    stallNudges: metrics.reduce((sum, m) => sum + m.steering.stallNudges, 0),
    childPromptShare: totalPrompt > 0 ? childPrompt / totalPrompt : null,
  };
}

function alignmentOf(
  plan: ThreadPlan,
  userTexts: string[],
  metrics: RunMetrics[],
): ReviewDigest['alignment'] {
  const userPlan =
    plan.goal.trim() ||
    plan.final?.trim() ||
    (userTexts[0] ? clip(userTexts[0], 240) : '');
  if (!userPlan) {
    return {
      verdict: 'unknown',
      userPlan: '(no plan or user message on this thread)',
      note: 'Nothing on disk states what the user wanted.',
    };
  }
  const joined = userTexts.join('\n');
  const askLike = ASK_RE.test(userTexts[0] ?? '') || ASK_RE.test(joined.slice(0, 200));
  const changeLike = CHANGE_RE.test(userPlan) || CHANGE_RE.test(joined);
  const edited = metrics.some((m) => m.edits > 0);
  const completed = metrics.some((m) => m.status === 'completed');
  const failedOnly =
    metrics.length > 0 && metrics.every((m) => m.status === 'error' || m.status === 'cancelled');
  const open = planHasOpenWork(plan);
  const todos = planTodoCounts(plan);

  if (askLike && edited && !changeLike) {
    return {
      verdict: 'diverged',
      userPlan,
      note: 'The user asked a question; the agent edited files.',
    };
  }
  if (changeLike && completed && !edited) {
    return {
      verdict: 'diverged',
      userPlan,
      note: 'The user asked for a change; no applied edits were recorded.',
    };
  }
  if (open && completed) {
    return {
      verdict: 'partial',
      userPlan,
      note: `The plan still has ${todos.pending + todos.in_progress} open todo(s).`,
    };
  }
  if (failedOnly) {
    return {
      verdict: 'diverged',
      userPlan,
      note: 'Every run ended in error or cancel before the work finished.',
    };
  }
  if (completed && !open) {
    return {
      verdict: 'aligned',
      userPlan,
      note: isThreadPlanEmpty(plan)
        ? 'Runs completed against the first user message (no plan file).'
        : 'Runs completed against the recorded plan.',
    };
  }
  return {
    verdict: 'partial',
    userPlan,
    note: 'Work is still in progress or unfinished.',
  };
}

function findingsOf(
  metrics: RunMetrics[],
  numbers: ReviewNumbers,
  alignment: ReviewDigest['alignment'],
  focus: RunMetrics | undefined,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const push = (kind: ReviewFinding['kind'], summary: string, evidence: string[]) => {
    findings.push({ kind, summary, evidence });
  };

  if (alignment.verdict === 'diverged') {
    push('misread-intent', alignment.note, [`User plan: ${clip(alignment.userPlan, 160)}`]);
  }

  const growth = metrics
    .map((m) => m.promptGrowth)
    .filter((value): value is number => value !== null);
  const maxGrowth = growth.length > 0 ? Math.max(...growth) : null;
  const idle = metrics.filter((m) => m.edits > 0 && m.idleShare !== null && m.idleShare >= 0.5);
  if (numbers.iterations >= 8 || numbers.promptTokens >= 100_000 || (maxGrowth !== null && maxGrowth >= 3) || idle.length > 0) {
    const evidence = [
      `${numbers.iterations} iterations`,
      `${numbers.promptTokens} own prompt tokens`,
    ];
    if (maxGrowth !== null) evidence.push(`prompt growth up to ${maxGrowth.toFixed(1)}×`);
    if (idle.length > 0) {
      evidence.push(
        `${idle.length} run(s) spent ≥50% of prompt tokens before the first edit`,
      );
    }
    push('over-work', 'The thread spent more looping and context than the outcome needed.', evidence);
  }

  if (
    (numbers.oneToolShare !== null && numbers.oneToolShare >= 0.5) ||
    numbers.planOnly >= 1 ||
    numbers.readWalks >= 1
  ) {
    const evidence: string[] = [];
    if (numbers.oneToolShare !== null) {
      evidence.push(`${Math.round(numbers.oneToolShare * 100)}% of iterations made one tool call`);
    }
    if (numbers.planOnly >= 1) evidence.push(`${numbers.planOnly} plan-only iteration(s)`);
    if (numbers.readWalks >= 1) evidence.push(`${numbers.readWalks} read walk(s)`);
    push('unnecessary-calls', 'Calls that could have been batched or skipped.', evidence);
  }

  const wasteEvidence: string[] = [];
  if (numbers.failedEdits > 0) wasteEvidence.push(`${numbers.failedEdits} failed edit(s)`);
  if (numbers.stallNudges > 0) wasteEvidence.push(`${numbers.stallNudges} stall nudge(s)`);
  const unverified = metrics.filter((m) => m.verifiedAfterEdit === false).length;
  if (unverified > 0) wasteEvidence.push(`${unverified} edit run(s) never checked by a command`);
  const limits = metrics.flatMap((m) => (m.limitReason ? [m.limitReason] : []));
  if (limits.length > 0) wasteEvidence.push(`stopped: ${[...new Set(limits)].join(', ')}`);
  const toolErrors = metrics.reduce(
    (sum, m) => sum + Object.values(m.toolOutcomes).reduce((n, o) => n + o.errors, 0),
    0,
  );
  if (toolErrors > 0) wasteEvidence.push(`${toolErrors} tool error(s)`);
  if (focus) {
    for (const signal of signalsOf(focus).slice(0, 3)) {
      wasteEvidence.push(`${signal.area}: ${signal.signal}`);
    }
  }
  if (wasteEvidence.length > 0) {
    push('waste', 'Spend that did not move the user plan forward.', wasteEvidence);
  }

  const batched = numbers.oneToolShare === null || numbers.oneToolShare < 0.5;
  const verified = metrics.some((m) => m.verifiedAfterEdit === true);
  if (alignment.verdict === 'aligned' && numbers.completed > 0 && batched) {
    const evidence = [`${numbers.completed}/${numbers.runs} run(s) completed`, `${numbers.iterations} iterations`];
    if (verified) evidence.push('an edit run ran a command after the last edit');
    if (numbers.failedEdits === 0) evidence.push('no failed edits');
    push('good', 'The agent finished with the plan and without the usual waste markers.', evidence);
  }

  return findings;
}

function suggestionsOf(findings: ReviewFinding[]): string[] {
  const kinds = new Set(findings.map((finding) => finding.kind));
  const out: string[] = [];
  if (kinds.has('unnecessary-calls')) {
    out.push('Batch independent reads and searches in one turn instead of serial single-tool iterations.');
  }
  if (kinds.has('over-work')) {
    out.push('Stop once the asked outcome is reached; extra exploration is spend.');
  }
  if (kinds.has('waste')) {
    out.push('Re-read before editing, and run a check after the last edit.');
  }
  if (kinds.has('misread-intent')) {
    out.push('Match the user plan: answer a question without editing, or edit only what was asked.');
  }
  if (kinds.has('good') && out.length === 0) {
    out.push('No change needed on this thread; keep the same discipline on similar work.');
  }
  return out;
}

function pickExcerpts(input: {
  userTexts: string[];
  plan: ThreadPlan;
  lastAnswer: string;
  focus?: RunMetrics;
  findings: ReviewFinding[];
}): ReviewExcerpt[] {
  const excerpts: ReviewExcerpt[] = [];
  const add = (source: string, text: string) => {
    if (!text.trim() || excerpts.length >= EXCERPT_LIMIT) return;
    excerpts.push({ source, text: clip(text, EXCERPT_MAX) });
  };
  if (input.userTexts[0]) add('first user message', input.userTexts[0]);
  const planText = input.plan.goal.trim() || input.plan.final?.trim() || '';
  if (planText) add('thread plan', planText);
  if (input.lastAnswer) add('last assistant answer', input.lastAnswer);
  if (input.focus) {
    add(
      `run ${input.focus.runId.slice(0, 8)}`,
      `status ${input.focus.status}${input.focus.limitReason ? ` · ${input.focus.limitReason}` : ''} · ${input.focus.iterations} iterations · ${input.focus.toolCalls} tools · ${input.focus.promptTokens.own} prompt tokens`,
    );
  }
  const evidence = input.findings[0]?.evidence[0];
  if (evidence) add('digest fact', evidence);
  return excerpts;
}

/** Digest + ≤5 excerpts for the narrative model. Never the raw trace. */
export function buildReviewInput(digest: ReviewDigest, excerpts: ReviewExcerpt[]): ReviewModelInput {
  return { digest, excerpts: excerpts.slice(0, EXCERPT_LIMIT) };
}

export function analyzeThreadFrom(input: {
  threadId: string;
  title: string;
  plan: ThreadPlan;
  ledger: LedgerEnvelope[];
  runs: RunSummary[];
  metrics: RunMetrics[];
  focusRunId?: string;
}): ThreadReviewAnalysis {
  const flat = flattenRuns(input.runs);
  const fingerprint = reviewFingerprint({
    threadId: input.threadId,
    ledger: input.ledger,
    runs: flat,
  });
  const numbers = numbersOf(input.metrics);
  const userTexts = texts(input.ledger, 'user');
  const alignment = alignmentOf(input.plan, userTexts, input.metrics);
  const focus = input.focusRunId
    ? input.metrics.find((m) => m.runId === input.focusRunId)
    : undefined;
  const findings = findingsOf(input.metrics, numbers, alignment, focus);
  const digest: ReviewDigest = {
    threadId: input.threadId,
    title: input.title,
    ...(input.focusRunId ? { focusRunId: input.focusRunId } : {}),
    alignment,
    findings,
    suggestions: suggestionsOf(findings),
    numbers,
    runs: input.metrics.map((m) => ({
      runId: m.runId,
      status: m.status,
      iterations: m.iterations,
      toolCalls: m.toolCalls,
      promptTokens: m.promptTokens.own,
      ...(m.promptGrowth === null ? { promptGrowth: null } : { promptGrowth: m.promptGrowth }),
      health: {
        removalStepShare: m.health.removalStepShare,
        residueShare: m.health.residueShare?.last ?? null,
        prefixStability: m.health.prefixStability,
        reReadRate: m.health.reReads.rate,
        repeatSearchRate: m.health.repeatSearches.rate,
        adviceFollowRate: m.health.advice.rate,
        childShare: m.childShare,
        lowEffortWithoutProgress: m.health.effortVsProgress.lowEffortWithoutProgress,
      },
    })),
  };
  const excerpts = pickExcerpts({
    userTexts,
    plan: input.plan,
    lastAnswer: lastAssistant(input.ledger),
    ...(focus ? { focus } : {}),
    findings,
  });
  return { fingerprint, digest, excerpts };
}

/**
 * Read the thread from an agent home and build a digest. Parent threads
 * include sub-agent runs. `focusRunId` is display-only and not part of the fingerprint.
 */
export async function analyzeThread(
  home: string,
  threadId: string,
  focusRunId?: string,
): Promise<ThreadReviewAnalysis> {
  const owner = reviewOwnerThread(home, threadId);
  const ledger = (await readLedger(home, owner.threadId)).envelopes;
  const runs = await listRuns(home, { threadId: owner.threadId });
  const metrics = await loadRunMetrics(home, flattenRuns(runs));
  const plan = await readPlan(home, owner.threadId);
  return analyzeThreadFrom({
    threadId: owner.threadId,
    title: owner.title,
    plan,
    ledger,
    runs,
    metrics,
    ...(focusRunId ? { focusRunId } : {}),
  });
}

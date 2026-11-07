'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import {
  analyzeThread,
  buildReviewInput,
  flattenRuns,
  listRuns,
  readLedger,
  reviewFingerprint,
  reviewOwnerThread,
} from '@agent/agent-eval';
import { sameReviewFingerprint } from '@agent/agent-models';

import { agentHome, evalHome } from '../lib/home';
import { reviewHref } from './href';
import { generateNarrative } from './narrative';
import { readReview, writeReview } from './store';

function safeId(value: string): string | null {
  const id = value.trim();
  if (!id || id.length > 80 || id.includes('/') || id.includes('\\') || id.includes('..')) return null;
  return id;
}

function homeOf(flag: string): string {
  return flag === 'eval' ? evalHome() : agentHome();
}

function revalidateAndReturn(threadId: string, runId: string | undefined, homeFlag: string): never {
  revalidatePath(`/threads/${threadId}`);
  revalidatePath(`/threads/${threadId}/review`);
  if (runId) revalidatePath(`/runs/${runId}`);
  redirect(reviewHref(threadId, { homeFlag, runId }));
}

/**
 * Manual-only. Matching fingerprint → stored artifact, no model call.
 * Changed thread → digest always, narrative if the model answers, else digest-only.
 */
export async function requestReview(formData: FormData): Promise<void> {
  const rawThreadId = safeId(String(formData.get('threadId') ?? ''));
  const runId = safeId(String(formData.get('runId') ?? '')) ?? undefined;
  const homeFlag = String(formData.get('home') ?? '');
  if (!rawThreadId) return;

  const home = homeOf(homeFlag);
  const { threadId, model } = reviewOwnerThread(home, rawThreadId);
  const ledger = (await readLedger(home, threadId)).envelopes;
  const runs = flattenRuns(await listRuns(home, { threadId }));
  const fingerprint = reviewFingerprint({ threadId, ledger, runs });
  const stored = await readReview(home, threadId);
  if (stored && sameReviewFingerprint(stored.fingerprint, fingerprint)) {
    revalidateAndReturn(threadId, runId, homeFlag);
  }

  const analysis = await analyzeThread(home, rawThreadId, runId);
  const narrative = await generateNarrative(
    buildReviewInput(analysis.digest, analysis.excerpts),
    model,
  );
  await writeReview(home, {
    threadId: analysis.digest.threadId,
    fingerprint: analysis.fingerprint,
    createdAt: new Date().toISOString(),
    digest: analysis.digest,
    narrative,
  });
  revalidateAndReturn(analysis.digest.threadId, runId, homeFlag);
}

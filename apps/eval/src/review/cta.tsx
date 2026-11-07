import {
  flattenRuns,
  listRuns,
  readLedger,
  reviewFingerprint,
  reviewOwnerThread,
} from '@agent/agent-eval';
import { sameReviewFingerprint } from '@agent/agent-models';

import { ReviewButton } from './button';
import { reviewHref } from './href';
import { readReview } from './store';

/**
 * Header control: go to an existing verdict, or run one (lands on the review page).
 */
export async function ReviewCta({
  home,
  threadId,
  runId,
  homeFlag = '',
}: {
  home: string;
  threadId: string;
  runId?: string;
  homeFlag?: string;
}) {
  const owner = reviewOwnerThread(home, threadId);
  const [ledger, runs] = await Promise.all([
    readLedger(home, owner.threadId),
    listRuns(home, { threadId: owner.threadId }),
  ]);
  const fingerprint = reviewFingerprint({
    threadId: owner.threadId,
    ledger: ledger.envelopes,
    runs: flattenRuns(runs),
  });
  const stored = await readReview(home, owner.threadId);
  const stale = stored ? !sameReviewFingerprint(stored.fingerprint, fingerprint) : false;
  const href = reviewHref(owner.threadId, { homeFlag, runId });

  if (stored && !stale) {
    return (
      <a className="review-btn" href={href}>
        Open review
      </a>
    );
  }

  return (
    <ReviewButton
      threadId={threadId}
      {...(runId ? { runId } : {})}
      homeFlag={homeFlag}
      label={stored ? 'Review again' : 'Review'}
    />
  );
}

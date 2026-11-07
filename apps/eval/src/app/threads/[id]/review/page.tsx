import {
  flattenRuns,
  listRuns,
  readCatalog,
  readLedger,
  reviewFingerprint,
  reviewOwnerThread,
} from '@agent/agent-eval';
import { sameReviewFingerprint } from '@agent/agent-models';

import { homeFor } from '../../../../lib/home';
import { ReviewButton } from '../../../../review/button';
import { readReview } from '../../../../review/store';
import { ReviewVerdict } from '../../../../review/verdict';

export const dynamic = 'force-dynamic';

type Search = Promise<{ home?: string; run?: string }>;

export default async function ThreadReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Search;
}) {
  const { id } = await params;
  const search = await searchParams;
  const { home, query } = homeFor(search.home);
  const homeFlag = search.home === 'eval' ? 'eval' : '';
  const runId = typeof search.run === 'string' && search.run ? search.run : undefined;
  const owner = reviewOwnerThread(home, id);
  const thread = readCatalog(home).find((item) => item.id === owner.threadId);
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
  const title = thread?.title ?? owner.title;
  const threadHref = `/threads/${owner.threadId}${query}`;

  return (
    <div className="review-page">
      <p className="muted crumbs">
        <a href="/">Threads</a>
        {' / '}
        <a href={threadHref}>{title}</a>
        {' / '}review
        {query ? ' · eval home' : ''}
      </p>

      {stored ? (
        <ReviewVerdict
          review={stored}
          stale={stale}
          threadId={id}
          homeFlag={homeFlag}
          {...(runId ? { focusRunId: runId, runId } : {})}
        />
      ) : (
        <article className="verdict">
          <p className="verdict-kicker">{title}</p>
          <h1>No review yet</h1>
          <p>
            This page is the verdict for the thread: what was asked, whether the agent matched it,
            and what to change. The run inspector (iterations, calls, raw trace) stays on the run
            page.
          </p>
          <ReviewButton
            threadId={id}
            {...(runId ? { runId } : {})}
            homeFlag={homeFlag}
            label="Run review"
          />
        </article>
      )}

      {stored && !stale ? (
        <p className="review-again">
          <ReviewButton
            threadId={id}
            {...(runId ? { runId } : {})}
            homeFlag={homeFlag}
            label="Review again"
          />
        </p>
      ) : null}
    </div>
  );
}

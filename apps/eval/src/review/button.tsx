'use client';

import { useFormStatus } from 'react-dom';

import { requestReview } from './actions';

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="review-btn" disabled={pending} aria-busy={pending}>
      {pending ? 'Reviewing…' : label}
    </button>
  );
}

/** Posts the server action. Pending label is the only client behaviour. */
export function ReviewButton({
  threadId,
  runId,
  homeFlag,
  label,
}: {
  threadId: string;
  runId?: string;
  homeFlag: string;
  label: string;
}) {
  return (
    <form action={requestReview} className="review-form">
      <input type="hidden" name="threadId" value={threadId} />
      {runId ? <input type="hidden" name="runId" value={runId} /> : null}
      {homeFlag ? <input type="hidden" name="home" value={homeFlag} /> : null}
      <Submit label={label} />
    </form>
  );
}

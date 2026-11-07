import type { ReviewFindingKind, ThreadReview } from '@agent/agent-models';

import { tokens, when } from '../lib/format';
import { ReviewButton } from './button';

const KIND_LABEL: Record<ReviewFindingKind, string> = {
  'over-work': 'Over-work',
  'unnecessary-calls': 'Unnecessary calls',
  'misread-intent': 'Misread intent',
  waste: 'Waste',
  good: 'What went well',
};

const ALIGNMENT_HEADLINE = {
  aligned: 'Aligned with the user plan',
  partial: 'Partly aligned with the user plan',
  diverged: 'Diverged from the user plan',
  unknown: 'Cannot tell if this matched the plan',
} as const;

function percent(value: number | null): string {
  return value === null ? '–' : `${Math.round(value * 100)}%`;
}

/**
 * The review document: verdict first, numbers last.
 * Empty/stale states belong on the page, not here.
 */
export function ReviewVerdict({
  review,
  focusRunId,
  stale,
  threadId,
  homeFlag,
  runId,
}: {
  review: ThreadReview;
  focusRunId?: string;
  stale: boolean;
  threadId: string;
  homeFlag: string;
  runId?: string;
}) {
  const { digest, narrative } = review;
  const focus = focusRunId ? digest.runs.find((run) => run.runId === focusRunId) : undefined;
  const numbers = digest.numbers;
  const findings = digest.findings;
  const suggestions = narrative?.suggestions.length ? narrative.suggestions : digest.suggestions;
  const detail: [string, string][] = [
    ['Runs completed', `${numbers.completed} / ${numbers.runs}`],
    ['Iterations', String(numbers.iterations)],
    ['Tool calls', String(numbers.toolCalls)],
    ['Prompt tokens', tokens(numbers.promptTokens)],
    ['Completion tokens', tokens(numbers.completionTokens)],
    ['Edits / failed', `${numbers.edits} / ${numbers.failedEdits}`],
    ['One-tool iterations', percent(numbers.oneToolShare)],
    ['Plan-only', String(numbers.planOnly)],
    ['Read walks', String(numbers.readWalks)],
    ['Stall nudges', String(numbers.stallNudges)],
    ['Sub-agent prompt share', percent(numbers.childPromptShare)],
  ];

  return (
    <article className={`verdict verdict-${digest.alignment.verdict}`}>
      <p className="verdict-kicker">
        {digest.title} · {when(review.createdAt)}
        {narrative ? '' : ' · digest only (no model narrative)'}
      </p>
      <h1>{ALIGNMENT_HEADLINE[digest.alignment.verdict]}</h1>
      {stale ? (
        <div className="notice notice-row">
          <span>This thread changed after this review.</span>
          <ReviewButton
            threadId={threadId}
            {...(runId ? { runId } : {})}
            homeFlag={homeFlag}
            label="Review again"
          />
        </div>
      ) : null}

      <section>
        <h2>What they asked</h2>
        <p className="verdict-plan">{digest.alignment.userPlan}</p>
        <p className="muted">{digest.alignment.note}</p>
      </section>

      <section>
        <h2>What happened</h2>
        {narrative ? (
          <>
            <p className="verdict-summary">{narrative.summary}</p>
            <p className="muted">{narrative.alignment}</p>
          </>
        ) : (
          <p className="verdict-summary">{digest.alignment.note}</p>
        )}
        {focus ? (
          <p className="muted">
            Focused run {focus.runId.slice(0, 8)}: {focus.status} · {focus.iterations} iterations ·{' '}
            {focus.toolCalls} tools · {tokens(focus.promptTokens)} prompt
          </p>
        ) : null}
      </section>

      <section>
        <h2>Findings</h2>
        {findings.length === 0 ? (
          <p className="muted">Nothing to flag from the ledger and traces.</p>
        ) : (
          <ul className="review-findings">
            {findings.map((finding, i) => {
              const narrativeText = narrative?.findings.find((item) => item.kind === finding.kind)?.text;
              return (
                <li key={`${finding.kind}-${i}`}>
                  <span className={`chip kind-${finding.kind}`}>{KIND_LABEL[finding.kind]}</span>{' '}
                  {narrativeText ?? finding.summary}
                  {finding.evidence.length > 0 ? (
                    <div className="muted small">{finding.evidence.join(' · ')}</div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h2>What to do</h2>
        {suggestions.length === 0 ? (
          <p className="muted">No suggestions from this digest.</p>
        ) : (
          <ul>
            {suggestions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        )}
      </section>

      <details className="verdict-numbers">
        <summary>Numbers from traces</summary>
        <div className="grid">
          {detail.map(([label, value]) => (
            <div className="card" key={label}>
              <div className="label">{label}</div>
              <div>{value}</div>
            </div>
          ))}
        </div>
      </details>
    </article>
  );
}

import { listRuns, readCatalog, stopLabel, type RunSummary } from '@agent/agent-eval';

import { agentHome } from '../lib/home';
import { tokens, when } from '../lib/format';
import { reviewHref } from '../review/href';
import { readReview } from '../review/store';

export const dynamic = 'force-dynamic';

export default async function ThreadsPage() {
  const home = agentHome();
  const threads = readCatalog(home).filter((thread) => !thread.parentThreadId);
  const runs = await listRuns(home);
  const byThread = new Map<string, RunSummary[]>();
  for (const run of runs) {
    byThread.set(run.threadId, [...(byThread.get(run.threadId) ?? []), run]);
  }
  const reviewByThread = new Map(
    await Promise.all(
      threads.map(async (thread) => [thread.id, await readReview(home, thread.id)] as const),
    ),
  );

  return (
    <>
      <h1>Threads</h1>
      <p className="muted">{home}</p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Thread</th>
              <th>Kind</th>
              <th>Model</th>
              <th>Runs</th>
              <th>Last run</th>
              <th>Prompt tokens</th>
              <th>Updated</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {threads.map((thread) => {
              const threadRuns = byThread.get(thread.id) ?? [];
              const last = threadRuns[0];
              const prompt = threadRuns.reduce(
                (sum, run) =>
                  sum + (run.usage?.own.promptTokens ?? 0) + (run.usage?.children.promptTokens ?? 0),
                0,
              );
              const reviewed = reviewByThread.get(thread.id);
              return (
                <tr key={thread.id}>
                  <td className="wrap">
                    <a href={`/threads/${thread.id}`}>{thread.title || thread.id}</a>
                  </td>
                  <td>{thread.kind}</td>
                  <td>{thread.model}</td>
                  <td>{threadRuns.length}</td>
                  <td className={last ? `status-${last.status}` : 'muted'}>
                    {last ? `${last.status}${last.limitReason ? ` · ${stopLabel(last.limitReason)}` : ''}` : '–'}
                  </td>
                  <td>{tokens(prompt)}</td>
                  <td>{when(thread.updatedAt)}</td>
                  <td>
                    <a href={reviewHref(thread.id)}>{reviewed ? 'Open review' : 'Review'}</a>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

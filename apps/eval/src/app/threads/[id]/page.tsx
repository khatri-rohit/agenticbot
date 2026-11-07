import { Fragment } from 'react';

import { listRuns, readCatalog, type RunSummary } from '@agent/agent-eval';

import { homeFor } from '../../../lib/home';
import { duration, tokens, when } from '../../../lib/format';
import { ReviewCta } from '../../../review/cta';

export const dynamic = 'force-dynamic';

type Search = Promise<{ home?: string }>;

function RunRows({
  runs,
  depth,
  query,
}: {
  runs: RunSummary[];
  depth: number;
  query: string;
}) {
  return (
    <>
      {runs.map((run) => (
        <Fragment key={run.runId}>
          <tr>
            <td style={{ paddingLeft: 8 + depth * 20 }}>
              <a href={`/runs/${run.runId}${query}`}>{run.runId.slice(0, 8)}</a>
            </td>
            <td className={`status-${run.status}`}>{run.status}</td>
            <td className="wrap">{run.limitReason ?? ''}</td>
            <td>{run.iterations}</td>
            <td>{run.toolCalls}</td>
            <td>
              {tokens(run.usage?.own.promptTokens)} / {tokens(run.usage?.children.promptTokens)}
            </td>
            <td>{duration(run.durationMs)}</td>
            <td>{when(run.startedAt)}</td>
          </tr>
          <RunRows runs={run.children} depth={depth + 1} query={query} />
        </Fragment>
      ))}
    </>
  );
}

export default async function ThreadPage({
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
  const thread = readCatalog(home).find((item) => item.id === id);
  const runs = await listRuns(home, { threadId: id });
  const title = thread?.title ?? id;

  return (
    <>
      <p className="muted crumbs">
        <a href="/">Threads</a>
        {' / '}
        {title}
        {query ? ' · eval home' : ''}
      </p>
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="muted">
            {thread
              ? `${thread.kind} · ${thread.model}${thread.workspaceRoot ? ` · ${thread.workspaceRoot}` : ''}`
              : 'Not in the catalog'}
            {` · ${runs.length} run${runs.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <div className="page-head-actions">
          <ReviewCta home={home} threadId={id} homeFlag={homeFlag} />
        </div>
      </div>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Status</th>
              <th>Limit</th>
              <th>Iterations</th>
              <th>Tools</th>
              <th>Prompt own / sub-agents</th>
              <th>Duration</th>
              <th>Started</th>
            </tr>
          </thead>
          <tbody>
            <RunRows runs={runs} depth={0} query={query} />
          </tbody>
        </table>
      </div>
      {runs.length === 0 ? <p className="muted">No traces for this thread.</p> : null}
    </>
  );
}

import { Fragment } from 'react';

import { listRuns, readCatalog, type RunSummary } from '@agent/agent-eval';

import { agentHome } from '../../../lib/home';
import { duration, tokens, when } from '../../../lib/format';

export const dynamic = 'force-dynamic';

function RunRows({ runs, depth }: { runs: RunSummary[]; depth: number }) {
  return (
    <>
      {runs.map((run) => (
        <Fragment key={run.runId}>
          <tr>
            <td style={{ paddingLeft: 8 + depth * 20 }}>
              <a href={`/runs/${run.runId}`}>{run.runId.slice(0, 8)}</a>
            </td>
            <td>{run.model ?? '–'}</td>
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
          <RunRows runs={run.children} depth={depth + 1} />
        </Fragment>
      ))}
    </>
  );
}

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const home = agentHome();
  const thread = readCatalog(home).find((item) => item.id === id);
  const runs = await listRuns(home, { threadId: id });

  return (
    <>
      <h1>{thread?.title ?? id}</h1>
      <p className="muted">
        {thread ? `${thread.kind} · ${thread.model}${thread.workspaceRoot ? ` · ${thread.workspaceRoot}` : ''}` : 'Not in the catalog'}
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Run</th>
              <th>Model</th>
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
            <RunRows runs={runs} depth={0} />
          </tbody>
        </table>
      </div>
      {runs.length === 0 ? <p className="muted">No traces for this thread.</p> : null}
    </>
  );
}

import path from 'node:path';

import {
  areaRows,
  flattenRuns,
  listRuns,
  loadRunMetrics,
  readSuiteRun,
  type TrialResult,
} from '@agent/agent-eval';

import { evalHome } from '../../../lib/home';
import { tokens } from '../../../lib/format';

export const dynamic = 'force-dynamic';

/** The four grade parts as dots: checks, files, scope, budget. */
function GradeDots({ trial }: { trial: TrialResult }) {
  const parts: [string, boolean | undefined][] = [
    ['checks', trial.checksPassed],
    ['files', trial.filesPassed],
    ['scope', trial.scopeViolations ? trial.scopeViolations.length === 0 : undefined],
    ['budget', trial.budgetOk],
  ];
  return (
    <span className="dots">
      {parts.map(([label, ok]) => (
        <i key={label} title={`${label}: ${ok === undefined ? 'not graded' : ok ? 'ok' : 'failed'}`} className={ok === undefined ? 'dot' : ok ? 'dot ok' : 'dot bad'} />
      ))}
    </span>
  );
}

export default async function SuiteRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const home = evalHome();
  const suiteRun = await readSuiteRun(path.join(home, 'results', path.basename(decodeURIComponent(id))));
  const { meta, results } = suiteRun;
  const tasks = [...new Set(results.map((trial) => trial.taskId))];
  const maxTrial = Math.max(0, ...results.map((trial) => trial.trial));
  const runIds = new Set(results.flatMap((trial) => trial.runIds));
  const runs = flattenRuns(await listRuns(home)).filter(
    (run) => runIds.has(run.runId) || (run.parentRunId !== undefined && runIds.has(run.parentRunId)),
  );
  const areas = areaRows(await loadRunMetrics(home, runs)).filter((row) => row.runs > 0);

  return (
    <>
      <p className="muted crumbs">
        <a href="/results">suite runs</a> / {meta?.label ?? suiteRun.id}
      </p>
      <h1>{meta?.label ?? suiteRun.id}</h1>
      <p className="muted">
        {meta ? `${meta.suite} · ${meta.model} · harness ${meta.harnessSha.slice(0, 8)}${meta.harnessDirty ? '+dirty' : ''} · seed ${meta.seedHash.slice(0, 8)}` : 'no meta file (older suite run)'}
        {meta?.stopped ? ` · stopped: ${meta.stopped}` : ''}
      </p>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Task</th>
              {Array.from({ length: maxTrial }, (_, i) => (
                <th key={i}>Trial {i + 1}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task}>
                <td>{task}</td>
                {Array.from({ length: maxTrial }, (_, i) => {
                  const trial = results.find((r) => r.taskId === task && r.trial === i + 1);
                  if (!trial) return <td key={i} className="muted">–</td>;
                  const lastRun = trial.runIds.at(-1);
                  return (
                    <td key={i} className="wrap">
                      <span className={`trial-${trial.status}`}>{trial.status}</span> <GradeDots trial={trial} />
                      <div className="muted small">
                        {trial.ended ?? ''} · {tokens(trial.promptTokens)} · {trial.minutes ?? '–'} min
                        {trial.continues ? ` · ${trial.continues} continue` : ''}
                      </div>
                      {trial.reason ? <div className="muted small">{trial.reason}</div> : null}
                      {lastRun ? (
                        <a className="small" href={`/runs/${lastRun}?home=eval`}>
                          open run →
                        </a>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Where the cost went</h2>
      {areas.length === 0 ? (
        <p className="muted">No area tripped a threshold.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Area</th>
              <th>Runs</th>
              <th>Tokens in those runs</th>
              <th>Worst signal</th>
              <th>Owner</th>
            </tr>
          </thead>
          <tbody>
            {areas.map((row) => (
              <tr key={row.area}>
                <td>{row.area}</td>
                <td>{row.runs}</td>
                <td>{tokens(row.tokens)}</td>
                <td className="wrap">{row.worst ? `${row.worst.severity} · ${row.worst.signal}` : '–'}</td>
                <td className="wrap muted">{row.owner}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

import path from 'node:path';

import { listSuiteRuns, readSuiteRun } from '@agent/agent-eval';

import { evalHome } from '../../lib/home';
import { percent, tokens, when } from '../../lib/format';

export const dynamic = 'force-dynamic';

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export default async function ResultsPage() {
  const root = path.join(evalHome(), 'results');
  const ids = await listSuiteRuns(root);
  const runs = await Promise.all(ids.map((id) => readSuiteRun(path.join(root, id))));

  return (
    <>
      <h1>Suite runs</h1>
      <p className="muted">{root}</p>
      {runs.length === 0 ? (
        <p className="muted">No suite runs yet. Run: npx nx run @agent/agent-eval:run -- --suite regression --repeat 3</p>
      ) : (
        <div className="scroll">
          <table>
            <thead>
              <tr>
                <th>Suite run</th>
                <th>Suite</th>
                <th>Model</th>
                <th>Harness</th>
                <th>Trials</th>
                <th>Pass rate</th>
                <th>Median prompt</th>
                <th>Stopped</th>
                <th>Started</th>
              </tr>
            </thead>
            <tbody>
              {runs.map(({ id, meta, results }) => {
                const ran = results.filter((trial) => trial.status !== 'skipped');
                const passed = ran.filter((trial) => trial.status === 'passed').length;
                return (
                  <tr key={id}>
                    <td>
                      <a href={`/results/${encodeURIComponent(id)}`}>{meta?.label ?? id}</a>
                    </td>
                    <td>{meta?.suite ?? results[0]?.suite ?? '–'}</td>
                    <td>{meta?.model ?? results[0]?.model ?? '–'}</td>
                    <td>
                      {(meta?.harnessSha ?? results[0]?.harnessSha ?? '').slice(0, 8)}
                      {(meta?.harnessDirty ?? results[0]?.harnessDirty) ? '+dirty' : ''}
                    </td>
                    <td>
                      {ran.length}
                      {results.length > ran.length ? ` (+${results.length - ran.length} skipped)` : ''}
                    </td>
                    <td>{ran.length ? percent(passed / ran.length) : '–'}</td>
                    <td>{tokens(median(ran.map((trial) => trial.promptTokens ?? 0).filter((v) => v > 0)))}</td>
                    <td className="wrap">{meta?.stopped ?? (meta && !meta.finishedAt ? 'interrupted' : '')}</td>
                    <td>{when(meta?.startedAt ?? results[0]?.startedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

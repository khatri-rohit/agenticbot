import { capacityRates, readUsage } from '@agent/agent-eval';

import { agentHome } from '../../lib/home';
import { tokens, when } from '../../lib/format';

export const dynamic = 'force-dynamic';

function weekly(point: unknown): number | null {
  return point && typeof point === 'object' && 'weeklyRemainingPercent' in point
    ? (point as { weeklyRemainingPercent: number }).weeklyRemainingPercent
    : null;
}

export default async function UsagePage() {
  const home = agentHome();
  const { records, warnings } = await readUsage(home);
  const rates = capacityRates(records);
  const recent = [...records].reverse().slice(0, 200);

  return (
    <>
      <h1>Usage</h1>
      <p className="muted">
        {records.length} runs in the usage log{warnings ? ` · ${warnings} corrupt lines skipped` : ''}. Balance
        percentages are whole numbers shared with other clients: read rates over many runs.
      </p>
      <h2>% of the week per 1M prompt tokens</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Runs</th>
              <th>Prompt tokens</th>
              <th>Weekly % used</th>
              <th>% per 1M</th>
            </tr>
          </thead>
          <tbody>
            {rates.map((rate) => (
              <tr key={rate.model}>
                <td>{rate.model}</td>
                <td>{rate.runs}</td>
                <td>{tokens(rate.promptTokens)}</td>
                <td>{rate.weeklyPercent}</td>
                <td>{rate.weeklyPercentPer1M.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>Weekly allowance remaining, by run</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Finished</th>
              <th>Run</th>
              <th>Model</th>
              <th>Status</th>
              <th>Prompt</th>
              <th>Weekly left</th>
              <th style={{ width: '40%' }} />
              <th>Governor</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((record) => {
              const left = weekly(record.balanceAfter);
              const prompt =
                (record.usage?.own.promptTokens ?? 0) + (record.usage?.children.promptTokens ?? 0);
              return (
                <tr key={`${record.runId}-${record.ts}`}>
                  <td>{when(record.ts)}</td>
                  <td>
                    <a href={`/runs/${record.runId}`}>{record.runId.slice(0, 8)}</a>
                  </td>
                  <td>{record.model}</td>
                  <td className={`status-${record.status}`}>{record.status}</td>
                  <td>{tokens(prompt)}</td>
                  <td>{left === null ? '–' : `${left}%`}</td>
                  <td>{left === null ? null : <div className="bar" style={{ width: `${left}%` }} />}</td>
                  <td>{record.capacity}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}

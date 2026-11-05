import {
  findRun,
  listRuns,
  loadRunMetrics,
  readRunTrace,
  stopLabel,
  type RunMetrics,
  type TraceLine,
} from '@agent/agent-eval';

import { agentHome } from '../../../lib/home';
import { clip, duration, percent, tokens } from '../../../lib/format';

export const dynamic = 'force-dynamic';

/** Event types drawn as markers: the harness acting on the run. */
const MARKERS = new Set([
  'context_evicted',
  'context_compacted_inrun',
  'context_prefix_heavy',
  'limit',
  'stall_nudge',
  'research_gate',
  'budget_warning',
  'tool_note',
  'skill_loaded',
  'skill_evicted',
  'memory_gate',
  'context_compacted',
  'system1_report',
]);

function describe(line: TraceLine): string {
  switch (line.type) {
    case 'run_start':
      return `run start · ${line.model} · ${line.mode ?? ''} ${line.posture ?? ''} · depth ${line.depth ?? 0}${line.windowTokens ? ` · window ${tokens(line.windowTokens)}` : ''}${line.occupiedTokens ? ` · first prompt ${tokens(line.occupiedTokens)}` : ''}`;
    case 'llm_request':
      return `model call${line.estimatedPromptTokens ? ` · est ${tokens(line.estimatedPromptTokens)}` : ''}${line.reasoningEffort ? ` · effort ${line.reasoningEffort}` : ''}`;
    case 'llm_response':
      return `response · ${line.usage ? `${tokens(line.usage.promptTokens)} in / ${tokens(line.usage.completionTokens)} out` : 'no usage'} · ${duration(line.durationMs)} · ${line.finishReason ?? ''}${line.contentPreview ? ` — ${clip(line.contentPreview, 140)}` : ''}`;
    case 'tool_start':
      return `▶ ${line.toolName} ${clip(JSON.stringify(line.args ?? {}), 160)}`;
    case 'tool_complete':
      return `✓ ${line.toolName} · ${duration(line.durationMs)}${line.resultChars !== undefined ? ` · ${line.resultChars} chars` : ''} — ${clip(line.resultPreview, 120)}`;
    case 'tool_error':
      return `✗ ${line.toolName} — ${clip(line.error, 160)}`;
    case 'context_evicted':
      return `context evicted · ${line.evicted} results · ${tokens(line.beforeTokens)} → ${tokens(line.afterTokens)}`;
    case 'context_compacted_inrun':
      return `in-run compaction · ${tokens(line.beforeTokens)} → ${tokens(line.afterTokens)}`;
    case 'context_prefix_heavy':
      return `prefix heavy · ${tokens(line.promptTokens)}`;
    case 'limit':
      return `limit · ${line.reason}`;
    case 'stall_nudge':
      return `stall nudge · ${tokens(line.idleTokens)} with no edit`;
    case 'research_gate':
      return `research gate · ${line.toolName} refused`;
    case 'budget_warning':
      return `budget warning · ${tokens(line.promptTokens)} of ${tokens(line.limitPromptTokens)}`;
    case 'tool_note':
      return `note · ${line.note} on ${line.toolName} (×${line.count})`;
    case 'skill_loaded':
      return `skill loaded · ${line.name} (${line.source}, ~${tokens(line.tokens)})`;
    case 'skill_evicted':
      return `skill retired · ${line.name}`;
    case 'memory_gate':
      return `memory gate · ${line.verdict} ${line.target} — ${clip(line.why, 120)}`;
    case 'context_compacted':
      return `thread compacted through #${line.throughSeq} — ${clip(line.briefPreview, 120)}`;
    case 'system1_decision': {
      const d = line.decision;
      return `system 1 · ${d.mode} · ${d.baseline ?? 'default'} → ${d.chosen ?? d.baseline ?? 'default'}${d.applied ? ' (applied)' : ''} · ${d.reason}${d.latencyMs !== undefined ? ` · ${d.latencyMs}ms` : ''}`;
    }
    case 'system1_report': {
      const r = line.report;
      const fallbacks = r.fallbacks.map((f) => `${f.kind} ×${f.count}`).join(', ');
      return `system 1 report · ${r.mode} · ${r.calls} calls, ${r.applied} applied${r.latencyMs ? ` · p50 ${r.latencyMs.p50}ms / p95 ${r.latencyMs.p95}ms` : ''}${fallbacks ? ` · fallbacks ${fallbacks}` : ''}`;
    }
    case 'run_finish':
      return `run finish · ${line.status ?? ''}${line.limitReason ? ` · ${line.limitReason}` : ''} · ${duration(line.durationMs)}`;
    default: {
      // Every known type is handled; newer traces can still carry types this viewer predates.
      const unknown = line as { type: string };
      return `${unknown.type} ${clip(JSON.stringify(unknown), 160)}`;
    }
  }
}

function iterationOf(line: TraceLine): number | undefined {
  const value = (line as { iteration?: unknown }).iteration;
  return typeof value === 'number' ? value : undefined;
}

function MetricsPanel({ m }: { m: RunMetrics }) {
  const cards: [string, string][] = [
    ['Status', `${m.status}${m.limitReason ? ` · ${stopLabel(m.limitReason)}` : ''}`],
    ['Iterations / tools', `${m.iterations} / ${m.toolCalls}`],
    ['Prompt total', `${tokens(m.promptTokens.total)} (sub-agents ${percent(m.childShare)})`],
    ['Per call median / p90', m.promptPerCall ? `${tokens(m.promptPerCall.median)} / ${tokens(m.promptPerCall.p90)}` : '–'],
    ['Wall clock', duration(m.wallClockMs)],
    ['Edits', `${m.edits}${m.firstEdit ? ` · first at it ${m.firstEdit.iteration}` : ''}`],
    ['Idle share', percent(m.idleShare)],
    ['Network calls', String(m.networkCalls)],
    ['Read walks', m.readWalks.map((w) => `${w.path.split('/').at(-1)} ×${w.calls}`).join(', ') || 'none'],
    ['Re-reads after eviction', m.reReadsAfterEviction === null ? 'n/a (old trace)' : String(m.reReadsAfterEviction)],
    ['Steering', `stall ${m.steering.stallNudges} · gate ${m.steering.researchGates} · notes ${m.steering.toolNotes}`],
    ['Capacity', m.capacity ? `weekly ${m.capacity.weeklyPercent}%` : '–'],
    [
      'System 1',
      m.system1
        ? `${m.system1.mode} · ${m.system1.decisions} decisions · ${m.system1.mode === 'shadow' ? 'would change' : 'applied'} ${m.system1.mode === 'shadow' ? m.system1.changed : m.system1.applied}${m.system1.latencyMs ? ` · p95 ${m.system1.latencyMs.p95}ms` : ''}`
        : 'off',
    ],
    ['Memory gate', Object.entries(m.memoryGate).map(([verdict, n]) => `${verdict} ${n}`).join(' · ') || 'none'],
    ['Skills', `loaded ${m.skills.loaded} (~${tokens(m.skills.loadedTokens)}) · retired ${m.skills.evicted}`],
  ];
  return (
    <div className="grid">
      {cards.map(([label, value]) => (
        <div className="card" key={label}>
          <div className="label">{label}</div>
          <div>{value}</div>
        </div>
      ))}
    </div>
  );
}

export default async function RunPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const home = agentHome();
  const run = findRun(await listRuns(home), runId);
  if (!run) {
    return (
      <>
        <h1>Run {runId}</h1>
        <p className="muted">Not found under {home}.</p>
      </>
    );
  }
  const [{ lines }, [metrics]] = await Promise.all([
    readRunTrace(run.tracePath),
    loadRunMetrics(home, [run]),
  ]);
  // Anchors use the sink's seq; traces written before seq existed use the
  // 1-based line number instead.
  const anchor = (line: TraceLine, index: number) => line.seq ?? index + 1;
  let lastIteration: number | undefined;

  return (
    <>
      <h1>Run {run.runId}</h1>
      <p className="muted">
        <a href={`/threads/${run.threadId}`}>thread {run.threadId.slice(0, 8)}</a>
        {run.parentRunId ? (
          <>
            {' · sub-agent of '}
            <a href={`/runs/${run.parentRunId}`}>{run.parentRunId.slice(0, 8)}</a>
          </>
        ) : null}
        {' · '}
        {run.model ?? ''}
      </p>
      {metrics ? <MetricsPanel m={metrics} /> : null}
      {run.children.length > 0 ? (
        <>
          <h2>Sub-agent runs</h2>
          <ul>
            {run.children.map((child) => (
              <li key={child.runId}>
                <a href={`/runs/${child.runId}`}>{child.runId.slice(0, 8)}</a> · {child.status} ·{' '}
                {child.iterations} iterations · {tokens(child.usage?.own.promptTokens)} prompt
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <h2>Timeline</h2>
      <div className="timeline">
        {lines.map((line, index) => {
          const iteration = iterationOf(line);
          const newIteration = iteration !== undefined && iteration !== lastIteration;
          if (iteration !== undefined) lastIteration = iteration;
          const id = anchor(line, index);
          const classes = ['row', MARKERS.has(line.type) ? 'marker' : '', newIteration ? 'iteration' : '']
            .filter(Boolean)
            .join(' ');
          return (
            <div className={classes} id={`seq-${id}`} key={id}>
              <a className="seq" href={`#seq-${id}`}>
                #{id}
              </a>
              <span className="it">{iteration !== undefined ? `it ${iteration}` : ''}</span>
              <span>{describe(line)}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

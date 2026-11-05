import {
  iterationsOf,
  loadRunMetrics,
  readCall,
  readRun,
  readRunTrace,
  readToolResult,
  signalsOf,
  stopLabel,
  type CallDetail,
  type Iteration,
  type IterationTool,
  type MessageKind,
  type RunMetrics,
  type RunSummary,
  type TraceLine,
} from '@agent/agent-eval';

import { homeFor } from '../../../lib/home';
import { clip, duration, percent, tokens } from '../../../lib/format';

export const dynamic = 'force-dynamic';

type Search = Promise<{ call?: string; tool?: string; home?: string }>;
type Band = 'explore' | 'change' | 'verify' | 'none';

const KIND_LABEL: Record<MessageKind | 'tools', string> = {
  system: 'system',
  tools: 'tools',
  user: 'user',
  assistant: 'assistant',
  tool: 'tool result',
  injected: 'injected',
};

/** Explore = up to the first applied edit, change = through the last one, verify = after it. */
function bandsOf(entries: Iteration[]): Band[] {
  const applied = entries.map((entry) => entry.tools.some((tool) => tool.name === 'edit_file' && tool.outcome === 'ok'));
  const first = applied.indexOf(true);
  const last = applied.lastIndexOf(true);
  return entries.map((_, i) => (first < 0 ? 'none' : i <= first ? 'explore' : i <= last ? 'change' : 'verify'));
}

function marker(line: TraceLine): string {
  switch (line.type) {
    case 'context_evicted':
      return `evicted ${line.evicted} · ${tokens(line.beforeTokens)} → ${tokens(line.afterTokens)}`;
    case 'context_compacted_inrun':
      return `compacted · ${tokens(line.beforeTokens)} → ${tokens(line.afterTokens)}`;
    case 'context_prefix_heavy':
      return `prefix heavy · ${tokens(line.promptTokens)}`;
    case 'limit':
      return `limit · ${stopLabel(line.reason)}`;
    case 'stall_nudge':
      return `stall nudge · ${tokens(line.idleTokens)} idle`;
    case 'research_gate':
      return `research gate · ${line.toolName}`;
    case 'budget_warning':
      return `budget warning`;
    case 'tool_note':
      return `note · ${line.note}`;
    case 'skill_loaded':
      return `skill · ${line.name}`;
    case 'skill_evicted':
      return `skill retired · ${line.name}`;
    case 'memory_gate':
      return `memory ${line.verdict}`;
    default:
      return line.type;
  }
}

function toolClass(tool: IterationTool): string {
  if (tool.outcome === 'error' || tool.outcome === 'threw') return 'chip err';
  if (tool.exitCode !== undefined && tool.exitCode !== 0) return 'chip exit';
  return 'chip';
}

function toolLabel(tool: IterationTool): string {
  const target = (tool.args as { path?: unknown; pattern?: unknown; command?: unknown } | null) ?? {};
  const what = typeof target.path === 'string' ? target.path : typeof target.pattern === 'string' ? target.pattern : '';
  const exit = tool.exitCode !== undefined ? ` · exit ${tool.exitCode}` : '';
  const failed = tool.outcome === 'error' ? ' ✗' : tool.outcome === 'threw' ? ' ✗ threw' : '';
  return `${tool.name}${what ? ` ${clip(what, 28)}` : ''}${exit}${failed}`;
}

function Tree(props: { run: RunSummary; entries: Iteration[]; query: string; selectedCall?: number; selectedTool?: string }) {
  const { run, entries, query, selectedCall, selectedTool } = props;
  const bands = bandsOf(entries);
  const maxPrompt = Math.max(1, ...entries.map((entry) => entry.response?.usage?.promptTokens ?? 0));
  const children = [...run.children].sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? ''));
  let delegates = 0;
  let callIndex = 0;
  const sep = query ? '&' : '?';
  return (
    <div className="tree">
      {entries.map((entry, position) => {
        const index = entry.request ? ++callIndex : undefined;
        const prompt = entry.response?.usage?.promptTokens;
        const open = index === selectedCall || entry.tools.some((tool) => tool.toolCallId === selectedTool);
        const band = bands[position]!;
        const showBand = band !== 'none' && (position === 0 || bands[position - 1] !== band);
        return (
          <div key={`${position}`} className={`band band-${band}`}>
            {showBand ? <div className="band-label">{band === 'verify' ? 'verify + answer' : band}</div> : null}
            <details open={open} className={open ? 'node selected' : 'node'}>
              <summary>
                <span className="it">{entry.final ? 'final' : `it ${entry.iteration}`}</span>
                <span className="chip effort">{entry.request?.reasoningEffort ?? 'default'}</span>
                <span className="pbar" title={`${prompt ?? '?'} prompt tokens`}>
                  <span style={{ width: `${Math.round(((prompt ?? 0) / maxPrompt) * 100)}%` }} />
                </span>
                <span className="pnum">{tokens(prompt)}</span>
                {entry.tools.map((tool, i) => (
                  <span key={i} className={toolClass(tool)}>
                    {tool.name}
                  </span>
                ))}
                {entry.markers.length > 0 ? <span className="chip marker">{entry.markers.length} harness</span> : null}
              </summary>
              <div className="node-body">
                {index !== undefined ? (
                  <a className="row-link" href={`/runs/${run.runId}${query}${sep}call=${index}`}>
                    ▸ model call {index}
                    {entry.final ? ' (tools off)' : ''} · {tokens(prompt)} in / {tokens(entry.response?.usage?.completionTokens)} out ·{' '}
                    {duration(entry.response?.durationMs)}
                  </a>
                ) : null}
                {entry.system1 ? (
                  <div className="muted small">
                    System 1 {entry.system1.mode}: {entry.system1.baseline ?? 'default'} → {entry.system1.chosen ?? entry.system1.baseline ?? 'default'}
                    {entry.system1.applied ? ' (applied)' : ''} · {entry.system1.reason}
                  </div>
                ) : null}
                {entry.tools.map((tool, i) => {
                  const child = tool.name === 'delegate' ? children[delegates++] : undefined;
                  return (
                    <div key={i}>
                      {tool.toolCallId ? (
                        <a className="row-link" href={`/runs/${run.runId}${query}${sep}tool=${tool.toolCallId}`}>
                          ▸ <span className={toolClass(tool)}>{toolLabel(tool)}</span> {duration(tool.durationMs)}
                        </a>
                      ) : (
                        <span className="row-link">▸ {toolLabel(tool)}</span>
                      )}
                      {child ? (
                        <a className="row-link child" href={`/runs/${child.runId}${query}`}>
                          ↳ sub-agent run {child.runId.slice(0, 8)} · {child.status} · {tokens(child.usage?.own.promptTokens)}
                        </a>
                      ) : null}
                    </div>
                  );
                })}
                {entry.markers.map((line, i) => (
                  <div key={i} className="muted small">
                    ⚑ {marker(line)}
                  </div>
                ))}
              </div>
            </details>
          </div>
        );
      })}
    </div>
  );
}

function StackBar({ detail }: { detail: CallDetail }) {
  const order: (MessageKind | 'tools')[] = ['system', 'tools', 'user', 'assistant', 'tool', 'injected'];
  const total = Math.max(1, order.reduce((sum, kind) => sum + detail.tokensByKind[kind], 0));
  return (
    <>
      <div className="stack">
        {order.map((kind) =>
          detail.tokensByKind[kind] > 0 ? (
            <span key={kind} className={`kind-${kind}`} style={{ width: `${(detail.tokensByKind[kind] / total) * 100}%` }} />
          ) : null,
        )}
      </div>
      <div className="legend">
        {order.map((kind) =>
          detail.tokensByKind[kind] > 0 ? (
            <span key={kind}>
              <i className={`kind-${kind}`} /> {KIND_LABEL[kind]} {tokens(detail.tokensByKind[kind])}
            </span>
          ) : null,
        )}
      </div>
    </>
  );
}

async function CallInspector({ home, run, index }: { home: string; run: RunSummary; index: number }) {
  const detail = await readCall(home, run, index);
  if (!detail) return <p className="muted">This run has no model call {index}.</p>;
  const { call } = detail;
  const added = detail.input.filter((message) => message.added).length;
  const stubbed = detail.input.filter((message) => message.stub).length;
  return (
    <div className="inspector">
      <h2>
        Model call {call.index}
        {call.final ? ' · tools off' : ''}
      </h2>
      <p className="muted">
        iteration {call.iteration} · {tokens(call.promptTokens)} in / {tokens(call.completionTokens)} out · {duration(call.durationMs)} · effort{' '}
        {call.effort ?? 'default'}
      </p>
      {!call.recorded ? (
        <p className="notice">Input not recorded for this run (it predates call recording, or recording was off).</p>
      ) : (
        <>
          <h3>Input</h3>
          <StackBar detail={detail} />
          <p className="muted small">
            vs previous call: +{added} new · {detail.removed} no longer sent · {stubbed} shortened tool results
            {detail.ledger === 'rewound' ? ' · run was rewound out of the ledger' : ''}
          </p>
          {detail.tools ? (
            <details className="msg">
              <summary>
                <span className="kind kind-tools">tools</span> {detail.tools.names.length} definitions · {tokens(detail.tools.tokens)}
              </summary>
              <pre>{detail.tools.names.join(', ')}</pre>
            </details>
          ) : (
            <p className="muted small">No tools offered on this call.</p>
          )}
          {detail.input.map((message) => (
            <details key={message.index} className={message.added ? 'msg added' : 'msg'}>
              <summary>
                <span className={`kind kind-${message.kind}`}>{KIND_LABEL[message.kind]}</span>
                {message.stub ? <span className="chip">shortened</span> : null}
                {message.added ? <span className="chip new">new</span> : null}
                <span className="muted"> {tokens(message.tokens)} · </span>
                {message.toolCalls?.length
                  ? `calls ${message.toolCalls.map((tc) => tc.name).join(', ')}`
                  : clip(message.text ?? '(blob missing)', 110)}
              </summary>
              {message.toolCalls?.length ? (
                <pre>{message.toolCalls.map((tc) => `${tc.name} ${tc.args}`).join('\n')}</pre>
              ) : null}
              <pre>{message.text ?? '(blob missing)'}</pre>
            </details>
          ))}
        </>
      )}
      <h3>Output</h3>
      {detail.output ? (
        <>
          {detail.output.text ? <pre>{detail.output.text}</pre> : null}
          {detail.output.toolCalls.length > 0 ? (
            <pre>{detail.output.toolCalls.map((tc) => `→ ${tc.name} ${tc.args}`).join('\n')}</pre>
          ) : null}
        </>
      ) : (
        <p className="muted">Output not recorded; the trace keeps a preview in the raw timeline below.</p>
      )}
    </div>
  );
}

async function ToolInspector({ home, run, tool }: { home: string; run: RunSummary; tool: IterationTool }) {
  const full = tool.toolCallId ? await readToolResult(home, run.threadId, tool.toolCallId) : null;
  return (
    <div className="inspector">
      <h2>{tool.name}</h2>
      <p className="muted">
        stage {tool.stage} · {duration(tool.durationMs)} · outcome {tool.outcome ?? 'unknown'}
        {tool.exitCode !== undefined ? ` · exit ${tool.exitCode}` : ''}
      </p>
      <h3>Arguments</h3>
      <pre>{JSON.stringify(tool.args, null, 2)}</pre>
      <h3>Result{full === null ? ' (preview)' : ''}</h3>
      <pre>{full ?? tool.resultPreview ?? '(no result)'}</pre>
    </div>
  );
}

function Cards({ m }: { m: RunMetrics }) {
  const cards: [string, string][] = [
    ['Status', `${m.status}${m.limitReason ? ` · ${stopLabel(m.limitReason)}` : ''}`],
    ['Prompt total', `${tokens(m.promptTokens.total)} (sub-agents ${percent(m.childShare)})`],
    ['Per call median / p90', m.promptPerCall ? `${tokens(m.promptPerCall.median)} / ${tokens(m.promptPerCall.p90)}` : '–'],
    [
      'Phases',
      m.phases
        ? `explore ${tokens(m.phases.beforeFirstEdit)} · change ${tokens(m.phases.editing)} · after ${tokens(m.phases.afterLastEdit)}`
        : 'no edits',
    ],
    ['Calls', `${m.callShape.single} one-tool · ${m.callShape.multi} multi · ${m.callShape.planOnly} plan-only`],
    ['Prompt growth', m.promptGrowth ? `${m.promptGrowth.toFixed(1)}×` : '–'],
    ['Time', `model ${duration(m.time.modelMs)} · tools ${m.time.toolSeconds}s`],
    [
      'Tool failures',
      Object.entries(m.toolOutcomes)
        .filter(([, o]) => o.errors > 0)
        .map(([name, o]) => `${name} ${o.errors}/${o.calls}`)
        .join(' · ') || 'none recorded',
    ],
    ['System 1', m.system1 ? `${m.system1.mode} · ${m.system1.decisions} decisions · ${m.system1.applied} applied` : 'off'],
    ['Wall clock', duration(m.wallClockMs)],
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

export default async function RunPage({ params, searchParams }: { params: Promise<{ runId: string }>; searchParams: Search }) {
  const { runId } = await params;
  const search = await searchParams;
  const { home, query } = homeFor(search.home);
  const run = await readRun(home, runId);
  if (!run) {
    return (
      <>
        <h1>Run {runId}</h1>
        <p className="muted">Not found under {home}.</p>
      </>
    );
  }
  const [{ lines }, [metrics]] = await Promise.all([readRunTrace(run.tracePath), loadRunMetrics(home, [run])]);
  const entries = iterationsOf(lines);
  const callIndex = search.call ? Number(search.call) : undefined;
  const selectedTool = search.tool ? entries.flatMap((entry) => entry.tools).find((tool) => tool.toolCallId === search.tool) : undefined;
  const signals = metrics ? signalsOf(metrics) : [];

  return (
    <>
      <p className="muted crumbs">
        <a href={`/threads/${run.threadId}`}>thread {run.threadId.slice(0, 8)}</a>
        {run.parentRunId ? (
          <>
            {' / sub-agent of '}
            <a href={`/runs/${run.parentRunId}${query}`}>{run.parentRunId.slice(0, 8)}</a>
          </>
        ) : null}
        {' / '}run {run.runId.slice(0, 8)} · {run.model ?? ''}
        {query ? ' · eval home' : ''}
      </p>
      <h1>
        Run {run.runId.slice(0, 8)} <span className={`status-${run.status}`}>{run.status}</span>
      </h1>
      {signals.length > 0 ? (
        <div className="signals">
          {signals.map((signal, i) => (
            <span key={i} className={`chip sig-${signal.severity}`}>
              {signal.area} · {signal.signal}
            </span>
          ))}
        </div>
      ) : null}
      {metrics ? <Cards m={metrics} /> : null}
      <div className="runlayout">
        <section>
          <h2>Iterations</h2>
          <Tree run={run} entries={entries} query={query} {...(callIndex ? { selectedCall: callIndex } : {})} {...(search.tool ? { selectedTool: search.tool } : {})} />
        </section>
        <section>
          {callIndex ? (
            <CallInspector home={home} run={run} index={callIndex} />
          ) : selectedTool ? (
            <ToolInspector home={home} run={run} tool={selectedTool} />
          ) : (
            <p className="muted inspector">Open an iteration and pick a model call or a tool call to inspect it.</p>
          )}
        </section>
      </div>
      <details className="raw">
        <summary>Raw trace ({lines.length} lines)</summary>
        <div className="timeline">
          {lines.map((line, index) => (
            <div className="row" key={line.seq ?? index}>
              <span className="seq">#{line.seq ?? index + 1}</span>
              <span>{line.type}</span>
              <code>{clip(JSON.stringify(line), 220)}</code>
            </div>
          ))}
        </div>
      </details>
    </>
  );
}

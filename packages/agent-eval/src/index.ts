// @agent/agent-eval — eval readers, metrics, runner, gate, analyst.
// Pure library: reads $AGENT_HOME (catalog.db, traces, ledger, usage) and
// evals/ (tasks, baselines, results). No HTTP, no DOM, no DB writes.

export { readCatalog, type ThreadRecord } from './read/catalog.js';
export { readRunTrace, type ParsedTrace } from './read/trace.js';
export { readLedger } from './read/ledger.js';
export { readUsage, type UsageRecord } from './read/usage.js';
export { listRuns, type RunSummary } from './read/runs.js';

export {
  computeRunMetrics,
  type RunMetrics,
  type ToolHistogramEntry,
} from './metrics/run-metrics.js';
export { computeThreadMetrics, type ThreadMetrics } from './metrics/thread-metrics.js';

export { runSuite, type TaskResult, type SuiteResult } from './runner/runner.js';
export { type EvalTask, loadTask, loadSuite } from './runner/task.js';

export { recordBaseline, type BaselineRecord } from './gate/baseline.js';
export { runGate, type GateResult, type GateTaskDelta } from './gate/gate.js';

export {
  generateAnalystReport,
  type AnalystReport,
  type AnalystHypothesis,
  type AnalystCitation,
} from './analyst/generate.js';
export { readAnalystReport, listAnalystReports } from './analyst/report.js';
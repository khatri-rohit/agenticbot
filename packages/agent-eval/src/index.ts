// @agent/agent-eval — read-only access to what the agent runtime writes
// (catalog.db, ledgers, traces, usage log). Metrics, runner and gate land in
// their own stages (the eval plan of record, §6).

export { readCatalog, type ThreadRecord } from './read/catalog.js';
export { readLedger, type ParsedLedger } from './read/ledger.js';
export {
  linesOf,
  parseTrace,
  readRunTrace,
  type ParsedTrace,
  type TraceLine,
  type TraceLineOf,
} from './read/trace.js';
export {
  readUsage,
  type ParsedUsage,
  type UsageBalancePoint,
  type UsageRecord,
} from './read/usage.js';
export { listRuns, stopLabel, summarizeRun, type RunSummary } from './read/runs.js';

export {
  computeRunMetrics,
  toolStage,
  READ_WALK_MAX_LIMIT,
  READ_WALK_MIN_CALLS,
  type ReadWalk,
  type RunMetrics,
  type System1Metrics,
} from './metrics/run-metrics.js';
export {
  capacityRates,
  summarizeMetrics,
  type CapacityRate,
  type MetricsSummary,
} from './metrics/thread-metrics.js';
export { findRun, flattenRuns, loadRunMetrics } from './metrics/load.js';

export { loadTask, loadTasks, parseTask, type EvalTask, type LoadedTask, type TaskSuite } from './runner/task.js';
export { readSeed, seedEvalHome, type SeedInfo } from './runner/seed.js';
export { gradeTrial, scopeMatcher, type Grade } from './runner/score.js';
export { runSuite, system1SetupOf, type RunnerOptions, type SuiteRun, type TrialResult, type TrialStatus } from './runner/runner.js';

export { readResults, summarizeSuite, type SuiteStats, type TaskStats } from './gate/summary.js';
export { compareToBaseline, type Baseline, type GateCompare, type GateResult, type TaskVerdict } from './gate/gate.js';
export { readBaseline, recordBaseline } from './gate/baseline.js';

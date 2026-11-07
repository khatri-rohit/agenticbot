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
export { listRuns, readRun, stopLabel, summarizeRun, type RunSummary } from './read/runs.js';
export { iterationShape, iterationsOf, legacyToolStage, type Iteration, type IterationTool } from './read/iterations.js';
export { listCalls, readCall, readToolResult, type CallDetail, type CallMessage, type CallSummary, type MessageKind } from './read/calls.js';

export {
  computeRunMetrics,
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
export { AREA_OWNERS, areaRows, RULES, signalsOf, type Area, type AreaRow, type Signal } from './metrics/areas.js';
export {
  analyzeThread,
  buildReviewInput,
  reviewFingerprint,
  reviewOwnerThread,
  type ReviewExcerpt,
  type ReviewModelInput,
  type ThreadReviewAnalysis,
} from './analyze/review.js';

export { loadTask, loadTasks, parseTask, type EvalTask, type LoadedTask, type TaskSuite } from './runner/task.js';
export { readSeed, seedEvalHome, type SeedInfo } from './runner/seed.js';
export { gradeTrial, scopeMatcher, type Grade } from './runner/score.js';
export {
  runSuite,
  runTrial,
  system1SetupOf,
  SUITE_META_FILE,
  type RunnerOptions,
  type SuiteRun,
  type SuiteRunMeta,
  type TrialClient,
  type TrialEnd,
  type TrialOptions,
  type TrialResult,
  type TrialStatus,
} from './runner/runner.js';
export { ApiClient } from './runner/api-client.js';

export { listSuiteRuns, readResults, readSuiteRun, summarizeSuite, type SuiteStats, type TaskStats } from './gate/summary.js';
export { compareToBaseline, type Baseline, type GateCompare, type GateResult, type TaskVerdict } from './gate/gate.js';
export { readBaseline, recordBaseline } from './gate/baseline.js';

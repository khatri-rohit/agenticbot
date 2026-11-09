// @agent/agent-core — host-agnostic agent runtime.
// Pure library: no HTTP, no DOM, no database.
// Domain types and modes live in @agent/agent-models — import them from there.
// This file is the whole public surface: hosts (apps/api, apps/cli) use what
// is listed here, and everything else stays internal to the package.

// Skills
export {
  configureSkillRoots,
  skillLintWarnings,
  getSkill,
  invalidateSkillCatalog,
  listSkillCatalogs,
  parseSkillMarkdown,
} from './lib/tools/skills';
export type { SkillCatalogEntry } from './lib/tools/skills';

// Model layer
export { getClient, nativeOllamaBaseUrl } from './lib/model/client';
export { streamModelTurn } from './lib/model/stream';
export type { OnTextDelta, ModelCallOptions } from './lib/model/types';
export {
  getOllamaModelConfig,
  getServedContextLength,
  listOllamaModels,
  peekOllamaModelConfig,
  resolveReasoningEffort,
} from './lib/model/ollama-model-config';

// Loop
export { runLoop } from './lib/loop/loop';
export type {
  CapacityGate,
  ModelCallFn,
  ModelCallOverrides,
  RunLoopConfig,
  RunLoopResult,
  RunLoopStatus,
} from './lib/loop/types';
export type { AgentLimits } from './lib/loop/limits';
export { createStreamModelCall } from './lib/loop/model-call';

// System 1 (optional local scorer for harness decisions)
export { callSystem1, type System1ClientConfig } from './lib/system1/client';
export { System1Health } from './lib/system1/health';
export { createSystem1Port, type System1Port } from './lib/system1/port';
export {
  buildEffortLadder,
  buildEffortPolicy,
  modelOwnsAuto,
  resolveProfileThinking,
  type EffortPolicy,
  type ProfileThinking,
} from './lib/system1/effort';

// Tools
export {
  createRunToolset,
  createToolRegistry,
  listTools,
  registerToolProvider,
  type ToolProvider,
} from './lib/tools/registry';
export type {
  Tool,
  ToolGuidance,
  ToolRegistry,
} from './lib/tools/types';
export { createMemoryTool } from './lib/tools/memory';
export type { MemoryToolStore } from './lib/tools/memory';
export { createInMemoryPlanStore, createPlanTools } from './lib/tools/plan';
export type { PlanStore } from './lib/tools/plan';
export { gateMemoryOps, applyMemoryText, looksLikeSecret } from './lib/memory/gate';
export {
  buildReviewMessages,
  newUserTurns,
  parseReviewProposals,
} from './lib/memory/review';
export {
  createSessionSearchTool,
  type SessionSearchHit,
} from './lib/tools/session-search';

// Context
export { assembleContext } from './lib/context/assemble-context';
export type {
  AssembleContextInput,
  AssembleContextResult,
  MentionedThreadContext,
} from './lib/context/assemble-context';
export { loadWorkspaceRules } from './lib/context/load-workspace-rules';
export type { WorkspaceRuleFiles } from './lib/context/load-workspace-rules';
export {
  planCompaction,
  buildExtractiveSnapshot,
  packMentionedThread,
} from './lib/context/compact-snapshot';
export {
  acceptSectionedSummary,
  buildSummaryMessages,
} from './lib/context/sectioned-summary';

// Sub-agents
export {
  configureSubagentRoot,
  subagentProfileWarnings,
} from './lib/subagent/profiles';
export type { SubagentProfile } from './lib/subagent/types';
export { createSubagentRunner } from './lib/subagent/runner';
export type { SubagentHost } from './lib/subagent/runner';

// Events / trace
export {
  consoleTrace,
  teeTrace,
  traceCompactionEvent,
} from './lib/events/trace';
export type { TraceEvent } from '@agent/agent-models';

// Run manager
export { RunManager } from './lib/run/run-manager';
export { webTrustFromLedger } from './lib/loop/web-sources';
export type { RunClaim, RunEnd } from './lib/run/types';

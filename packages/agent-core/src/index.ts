// @agent/agent-core — host-agnostic agent runtime.
// Pure library: no HTTP, no DOM, no database.
// Domain types and modes live in @agent/agent-models — import them from there.

export {
  configureSkillRoots,
  formatPinnedSkills,
  formatSkillBodies,
  formatSkillsCatalog,
  skillCard,
  skillCore,
  skillForLoad,
  skillLintWarnings,
  skillSections,
  getSkill,
  invalidateSkillCatalog,
  listSkillCatalogs,
  listSkills,
  parseSkillMarkdown,
  resolveSkillsRoot,
} from './lib/tools/skills';
export type { SkillCatalogEntry } from './lib/tools/skills';

// Model layer
export {
  getClient,
  nativeOllamaBaseUrl,
  resolveOllamaBaseUrl,
} from './lib/model/client';
export { streamModelTurn } from './lib/model/stream';
export { estimatePromptTokens } from './lib/model/estimate-prompt-tokens';
export { parseTokenUsage } from './lib/model/parse-usage';
export type { OnTextDelta, ModelCallOptions } from './lib/model/types';
export {
  getOllamaModelConfig,
  listOllamaModels,
  resolveReasoningEffort,
} from './lib/model/ollama-model-config';

// Loop
export { runLoop } from './lib/loop/loop';
export type {
  ModelCallFn,
  RunLoopConfig,
  RunLoopResult,
  RunLoopStatus,
  SubagentParent,
  SubagentSpawner,
} from './lib/loop/types';
export {
  BUDGET_WARN_RATIO,
  DEFAULT_LIMITS,
  resolveLimits,
  type AgentLimits,
} from './lib/loop/limits';
export { createStreamModelCall } from './lib/loop/model-call';

// Tools
export {
  createToolRegistry,
  listTools,
  registerToolProvider,
  type ToolProvider,
} from './lib/tools/registry';
export { offer_choice } from './lib/tools/offer-choice';
export { recall } from './lib/tools/recall';
export type { Tool, ToolGuidance, ToolRegistry, ToolStage } from './lib/tools/type';
export { WORKSPACE_TOOLS, diffTool } from './lib/tools/workspace';
export {
  resolveWorkspacePath,
  isPathInside,
  globMatch,
} from './lib/tools/workspace-path';
export {
  assembleContext,
  refreshContextReport,
  stubLiveToolResults,
} from './lib/context/assemble-context';
export {
  compactCurrentRun,
  evictToolResults,
  ReadDedupe,
  retireSkillBodies,
} from './lib/context/residency';
export { loadWorkspaceRules } from './lib/context/load-workspace-rules';
export type { WorkspaceRuleFiles } from './lib/context/load-workspace-rules';
export type {
  AssembleContextInput,
  AssembleContextResult,
  MentionedThreadContext,
} from './lib/context/assemble-context';
export {
  chooseCompactThroughSeq,
  chooseCompactThroughSeqForTarget,
  buildExtractiveSnapshot,
  packMentionedThread,
} from './lib/context/compact-snapshot';
export { toLedgerRecord } from './lib/loop/to-ledger-record';
export { webSearchTool, webFetchTool } from './lib/tools/web-search';
export { createMemoryTool } from './lib/tools/memory';
export type { MemoryToolStore } from './lib/tools/memory';
export {
  applyPlanAction,
  applyTodoUpdate,
  createInMemoryPlanStore,
  createPlanTools,
} from './lib/tools/plan';
export type { PlanStore } from './lib/tools/plan';
export { gateMemoryOps, applyMemoryText } from './lib/memory/gate';

// Sub-agents
export { createDelegateTool } from './lib/subagent/delegate';
export {
  configureSubagentRoot,
  getSubagentProfile,
  listSubagentProfiles,
  subagentProfileWarnings,
} from './lib/subagent/profiles';
export {
  CHILD_STRIPPED_TOOLS,
  DIGEST_MAX_CHARS,
  MAX_CONCURRENT_SUBAGENTS,
} from './lib/subagent/types';
export type {
  SubagentContext,
  SubagentLimits,
  SubagentProfile,
} from './lib/subagent/types';
export {
  buildSubagentPrompt,
  parseReport,
  renderDigest,
  renderReport,
} from './lib/subagent/prompt';
export { createSubagentRunner } from './lib/subagent/runner';
export type { SubagentHost } from './lib/subagent/runner';

// Events / trace
export { consoleTrace, teeTrace, traceCompactionEvent } from './lib/events/trace';
export type { TraceEvent } from './lib/events/trace-types';
export { EventEmitter } from './lib/events/emitter';
export type { EventSubscriber } from './lib/events/types';

// Run manager
export { RunManager, RUN_HANDLE_TTL_MS } from './lib/run/run-manager';
export type {
  ResolveChoiceResult,
  RunHandle,
  RunHandleStatus,
  StartRunOptions,
} from './lib/run/types';

// Prompts
export { buildSystemPrompt } from './lib/prompts/system-prompt';
export { loadAgentIdentity } from './lib/prompts/load-agent-identity';

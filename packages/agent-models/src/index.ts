// @agent/agent-models — agent domain types.
// Pure types + mode config constants. Zero runtime deps.
// Consumed by @agent/agent-core, apps/api, apps/web.

export type {
  AgentEvent,
  AgentEventType,
  AgentEventWithoutSeq,
  RunStarted,
  TurnStarted,
  AssistantStarted,
  AssistantDelta,
  AssistantCompleted,
  ToolStarted,
  ToolCompleted,
  ToolFailed,
  ChoiceRequested,
  ChoiceResolved,
  MemoryUpdated,
  PlanUpdated,
  ContextCompacting,
  ContextCompacted,
  TurnCompleted,
  RunCompleted,
  RunSettled,
  RunError,
  LimitHit,
  SubrunStarted,
  SubrunProgress,
  SubrunSettled,
  System1Report,
} from './lib/event.js';

export { TASK_STATE_COMMANDS_MAX } from './lib/task-state.js';
export type {
  TaskClass,
  TaskCommand,
  TaskEvidence,
  TaskPhase,
  TaskStateSnapshot,
  WorkingSetEntry,
} from './lib/task-state.js';

export { SYSTEM1_AUTO_THINKING } from './lib/system1.js';
export type {
  System1EffortTrace,
  System1Fallback,
  System1FallbackKind,
  System1Mode,
  System1Question,
  System1RunReport,
  System1Scores,
  System1Site,
} from './lib/system1.js';

export type { Thread, ThreadKind } from './lib/thread.js';
export {
  CHAT_TITLE_MIN_WORDS,
  CHAT_TITLE_MAX_WORDS,
  clampChatTitle,
  normalizeThreadKind,
  parseThreadKind,
  isWorkspaceKind,
  normalizeWorkspaceRoot,
  workspaceRootKey,
  sameWorkspaceRoot,
} from './lib/thread.js';

export type {
  Message,
  MessageRole,
  MessageStatus,
  MessageAttachment,
  ImageAttachment,
  ThreadMentionAttachment,
  PendingToolCall,
} from './lib/message.js';
export {
  MAX_THREAD_MENTIONS,
  MAX_IMAGE_ATTACHMENTS,
  MAX_IMAGE_BYTES,
  IMAGE_MIME_TYPES,
  approximateDataUrlBytes,
  parseMessageAttachments,
  isThreadMention,
  isImageAttachment,
  imageAttachments,
  threadMentions,
} from './lib/message.js';

export type {
  ActiveRun,
  Run,
  RunStatus,
  ModelTurn,
  TokenUsage,
  RunUsage,
  UsageTotals,
  ChatMessage,
  ChatContentPart,
  StartRunRequest,
  RunPosture,
} from './lib/run.js';
export {
  emptyRunUsage,
  totalRunUsage,
  ASK_STRIPPED_TOOLS,
  normalizeRunPosture,
  parseStartRunRequest,
  applyPostureToTools,
  isAskStrippedTool,
  isReadOnlyPosture,
} from './lib/run.js';

export {
  CHARS_PER_TOKEN,
  ESTIMATED_TOKENS_PER_IMAGE,
  occupiedFromUsage,
} from './lib/token-estimate.js';

export type {
  ModeName,
  ModeConfig,
  ModeLimits,
  ModelRole,
  ModelRoles,
} from './lib/mode.js';
export {
  HOME_MODE,
  WORKSPACE_MODE,
  modeForKind,
  resolveModelRoles,
} from './lib/mode.js';

export type {
  OllamaEndpoint,
  OllamaListedModel,
  ThinkingValue,
  ThinkingMode,
  OllamaThinkingConfig,
  OllamaModelConfig,
  OllamaBalanceLimit,
  OllamaBalanceLegacy,
  OllamaBalanceModern,
  OllamaBalance,
} from './lib/ollama-model.js';

export type {
  LedgerRecord,
  LedgerSystemRecord,
  LedgerUserRecord,
  LedgerAssistantRecord,
  LedgerToolRecord,
  LedgerEnvelope,
  LedgerAppendMeta,
  LedgerResponse,
  WebTrust,
} from './lib/ledger.js';
export { envelopeToChatMessage, envelopeToUiMessage } from './lib/ledger.js';

export type {
  ToolRisk,
  ToolStage,
  ToolOrigin,
  ToolContext,
} from './lib/tool-context.js';

export type {
  SubagentHeader,
  SubagentReport,
  SubagentResult,
  SubagentSpec,
  SubagentStatus,
  SubagentThoroughness,
} from './lib/subagent.js';
export {
  encodeSubagentHeader,
  parseSubagentHeader,
  subagentDigestBody,
} from './lib/subagent.js';

export type {
  ChoiceOption,
  ChoiceRequest,
  ChoiceResult,
} from './lib/choice.js';
export {
  MAX_CHOICE_OPTIONS,
  MAX_CHOICE_TEXT_CHARS,
  ChoiceSkipped,
} from './lib/choice.js';

export type { TraceCallInput, TraceEvent, TraceMessageRef } from './lib/trace.js';
export { TRACE_SCHEMA_VERSION } from './lib/trace.js';

export type { HarnessFlags } from './lib/flags.js';
export { DEFAULT_HARNESS_FLAGS, parseHarnessFlags } from './lib/flags.js';

export type {
  ModelSettingRole,
  SideCallThinking,
  ModelRoleSetting,
  ModelSettings,
  ModelSettingSource,
  ResolvedModelSetting,
  ResolvedModelSettings,
} from './lib/model-settings.js';
export {
  MODEL_SETTING_ROLES,
  SIDE_CALL_THINKING_LEVELS,
  emptyModelSettings,
  isModelSettingRole,
  isSideCallThinking,
} from './lib/model-settings.js';

export type {
  MemoryTarget,
  MemoryOp,
  MemoryFiles,
  MemoryCaps,
  ProposedMemoryOp,
  MemoryGateVerdict,
  MemoryGateResult,
} from './lib/memory.js';
export {
  DEFAULT_MEMORY_CAPS,
  parseMemoryOp,
  revertedOpId,
} from './lib/memory.js';

export type {
  RunOutcome,
  ThreadLastRun,
  ThreadLastRunStatus,
} from './lib/thread-last-run.js';
export { lastRunFrom, parseThreadLastRun } from './lib/thread-last-run.js';

export type { LimitCode } from './lib/limits.js';
export {
  RUN_CANCELLED_REASON,
  RUN_INTERRUPTED_REASON,
  limitMessage,
  limitCodeOf,
  isResumableStop,
  isPauseStop,
} from './lib/limits.js';

export type { ToolOutcome } from './lib/tool-outcome.js';
export { legacyToolOutcome } from './lib/tool-outcome.js';

export type {
  PlanAction,
  PlanDecision,
  PlanNote,
  PlanNoteKind,
  PlanTodo,
  PlanTodoCounts,
  PlanTodoStatus,
  ThreadPlan,
} from './lib/plan.js';
export {
  MAX_PLAN_DECISIONS,
  MAX_PLAN_FINAL_CHARS,
  MAX_PLAN_GOAL_CHARS,
  MAX_PLAN_NOTE_CHARS,
  MAX_PLAN_NOTES,
  MAX_PLAN_TODO_CHARS,
  MAX_PLAN_TODOS,
  MAX_PLAN_PROMPT_NOTES,
  emptyThreadPlan,
  formatThreadPlanForPrompt,
  isThreadPlanEmpty,
  parseThreadPlan,
  planHasOpenWork,
  planTodoCounts,
  selectPlanForRewind,
} from './lib/plan.js';

export type {
  ContextBudget,
  ContextWindowSource,
  ContextReportLayer,
  ContextReport,
  Snapshot,
} from './lib/context.js';
export type { ContextWindowMode } from './lib/context.js';
export {
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  MIN_CONTEXT_WINDOW_TOKENS,
  contextBudgetForWindow,
  parseContextWindowMode,
  parseSnapshot,
  resolveContextWindow,
} from './lib/context.js';

export {
  CHILD_BUDGET_SHARE,
  CHILD_TOKENS_PER_TOOL_CALL,
  DIFF_MAX_CHARS,
  GLOB_MAX_RESULTS,
  GREP_WINDOW,
  MAX_CONCURRENT_SUBAGENTS,
  READ_WINDOW,
  REPORT_MAX_CHARS,
  TERMINAL_WINDOW,
  THOROUGHNESS_TOOL_CALLS,
  WALK_MAX_FILES,
  childAllocation,
  liveResultCapChars,
} from './lib/harness-limits.js';
export type { ChildLimits } from './lib/harness-limits.js';

export { REVIEW_FINDING_KINDS } from './lib/review.js';
export type {
  ReviewAlignment,
  ReviewAlignmentVerdict,
  ReviewDigest,
  ReviewFinding,
  ReviewFindingKind,
  ReviewFingerprint,
  ReviewNarrative,
  ReviewNumbers,
  ReviewRunGlance,
  ReviewRunHealth,
  ThreadReview,
} from './lib/review.js';
export {
  parseReviewNarrative,
  parseThreadReview,
  reviewFingerprintKey,
  sameReviewFingerprint,
} from './lib/review.js';

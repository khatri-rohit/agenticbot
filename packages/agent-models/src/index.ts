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
} from './lib/event.js';

export type { Thread, ThreadKind } from './lib/thread.js';
export {
  CHAT_TITLE_MIN_WORDS,
  CHAT_TITLE_MAX_WORDS,
  clampChatTitle,
  normalizeThreadKind,
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
  isThreadMention,
  isImageAttachment,
  imageAttachments,
  threadMentions,
} from './lib/message.js';

export type {
  Run,
  RunStatus,
  ModelTurn,
  TokenUsage,
  ChatMessage,
  ChatContentPart,
  StartRunRequest,
  RunPosture,
} from './lib/run.js';
export {
  ASK_STRIPPED_TOOLS,
  normalizeRunPosture,
  applyPostureToTools,
  isAskStrippedTool,
} from './lib/run.js';

export {
  CHARS_PER_TOKEN,
  ESTIMATED_TOKENS_PER_IMAGE,
  occupiedFromUsage,
} from './lib/token-estimate.js';

export type { ModeName, ModeConfig, ModeLimits } from './lib/mode.js';
export { HOME_MODE, WORKSPACE_MODE, modeForKind } from './lib/mode.js';

export type {
  OllamaEndpoint,
  OllamaListedModel,
  ThinkingValue,
  ThinkingMode,
  OllamaThinkingConfig,
  OllamaModelConfig,
} from './lib/ollama-model.js';

export type {
  LedgerRecord,
  LedgerSystemRecord,
  LedgerUserRecord,
  LedgerAssistantRecord,
  LedgerToolRecord,
  LedgerEnvelope,
  LedgerAppendMeta,
} from './lib/ledger.js';
export { envelopeToChatMessage, envelopeToUiMessage } from './lib/ledger.js';

export type {
  ToolRisk,
  ToolOrigin,
  ToolContext,
} from './lib/tool-context.js';

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

export type {
  MemoryTarget,
  MemoryOp,
  MemoryFiles,
  MemoryCaps,
  ProposedMemoryOp,
  MemoryGateVerdict,
  MemoryGateResult,
} from './lib/memory.js';
export { DEFAULT_MEMORY_CAPS } from './lib/memory.js';

export type {
  ThreadLastRun,
  ThreadLastRunStatus,
} from './lib/thread-last-run.js';
export {
  isLimitSkipToolContent,
  parseThreadLastRun,
} from './lib/thread-last-run.js';

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
export { DEFAULT_CONTEXT_BUDGET } from './lib/context.js';

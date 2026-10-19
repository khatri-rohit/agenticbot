// @org/agent-models — agent domain types.
// Pure types + mode config constants. Zero runtime deps.
// Consumed by @org/agent-core, apps/api, apps/web.

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
  ApprovalRequested,
  ApprovalResolved,
  MemoryUpdated,
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

export type { ModeName, ModeConfig } from './lib/mode.js';
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
} from './lib/ledger.js';
export { envelopeToChatMessage, envelopeToUiMessage } from './lib/ledger.js';

export type { ToolRisk, ToolOrigin, ToolContext } from './lib/tool-context.js';

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
  ContextBudget,
  ContextReportLayer,
  ContextReport,
  Snapshot,
} from './lib/context.js';
export { DEFAULT_CONTEXT_BUDGET } from './lib/context.js';

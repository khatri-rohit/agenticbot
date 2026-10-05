// @org/agent-models — agent domain types.
// Pure types + the RESEARCH_MODE config constant. Zero runtime deps.
// Consumed by @org/agent-core, apps/api, apps/web.

export type {
  AgentEvent,
  AgentEventType,
  RunStarted,
  TurnStarted,
  AssistantStarted,
  AssistantDelta,
  AssistantCompleted,
  ToolStarted,
  ToolCompleted,
  ToolFailed,
  TurnCompleted,
  RunCompleted,
  RunError,
  LimitHit,
} from './lib/event.js';

export type { Thread } from './lib/thread.js';

export type {
  Message,
  MessageRole,
  MessageStatus,
  PendingToolCall,
} from './lib/message.js';

export type {
  Run,
  RunStatus,
  ModelTurn,
  ChatMessage,
} from './lib/run.js';

export type { ModeName, ModeConfig } from './lib/mode.js';
export { RESEARCH_MODE } from './lib/mode.js';
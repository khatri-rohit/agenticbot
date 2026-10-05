// @org/agent-core — host-agnostic agent runtime.
// Pure library: no HTTP, no DOM, no database. Imports @org/agent-models for types.
// Populated across Phases 2-4.

// Re-export the domain types so consumers can import everything from @org/agent-core.
export type {
  AgentEvent,
  AgentEventType,
  Thread,
  Message,
  MessageRole,
  MessageStatus,
  PendingToolCall,
  Run,
  RunStatus,
  ModelTurn,
  ChatMessage,
  ModeName,
  ModeConfig,
} from '@org/agent-models';

export { RESEARCH_MODE } from '@org/agent-models';
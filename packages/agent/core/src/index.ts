// @org/agent-core — host-agnostic agent runtime.
// Pure library: no HTTP, no DOM, no database.

// Re-export domain types so consumers can import everything from @org/agent-core.
export type {
  AgentEvent,
  AgentEventType,
  AgentEventWithoutSeq,
  Thread,
  Message,
  MessageRole,
  MessageStatus,
  PendingToolCall,
  Run,
  RunStatus,
  ChatMessage,
  ModeName,
  ModeConfig,
} from '@org/agent-models';
export { RESEARCH_MODE } from '@org/agent-models';

// Model layer
export { client } from './lib/model/client';
export { invokeModelTurn } from './lib/model/invoke';
export { streamModelTurn } from './lib/model/stream';
export type { ModelTurn, OnTextDelta } from './lib/model/types';

// Loop
export { runLoop } from './lib/loop/loop';
export type {
  ModelCallFn,
  RunLoopConfig,
  RunLoopResult,
  RunLoopStatus,
} from './lib/loop/types';
export { DEFAULT_LIMITS, type AgentLimits } from './lib/loop/limits';
export { getContext } from './lib/loop/context';
export {
  createInvokeModelCall,
  createStreamModelCall,
} from './lib/loop/model-call';

// Tools
export { createToolRegistry } from './lib/tools/registry';
export type { Tool, ToolGuidance, ToolRegistry } from './lib/tools/type';
export { webSearchTool, webFetchTool, allTools } from './lib/tools/web-search';

// Events / trace
export { consoleTrace } from './lib/events/trace';
export type { TraceEvent } from './lib/events/trace-types';
export { EventEmitter } from './lib/events/emitter';
export type { EventSubscriber } from './lib/events/types';

// Run manager
export { RunManager } from './lib/run/run-manager';
export type {
  RunHandle,
  RunHandleStatus,
  StartRunOptions,
} from './lib/run/types';

// Prompts
export { buildSystemPrompt } from './lib/prompts/system-prompt';

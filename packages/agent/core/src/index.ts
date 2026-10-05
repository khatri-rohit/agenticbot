// @org/agent-core — host-agnostic agent runtime.
// Pure library: no HTTP, no DOM, no database.

// Re-export domain types so consumers can import everything from @org/agent-core.
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
  ChatMessage,
  ModeName,
  ModeConfig,
} from '@org/agent-models';
export { RESEARCH_MODE } from '@org/agent-models';

// Model layer
export { client } from './lib/model/client';
export { invokeModelTurn } from './lib/model/invoke';

// Loop
export { runLoop } from './lib/loop/loop';
export type {
  ModelTurn,
  ModelCallFn,
  RunLoopConfig,
  RunLoopResult,
} from './lib/loop/loop';
export { DEFAULT_LIMITS, type AgentLimits } from './lib/loop/limits';
export { getContext } from './lib/loop/context';

// Tools
export {
  createToolRegistry,
  type Tool,
  type ToolGuidance,
  type ToolRegistry,
} from './lib/tools/registry';
export { webSearchTool, allTools } from './lib/tools/web-search';
export {
  firecrawlSearch,
  firecrawlGetPageContent,
  compactToolPayload,
  MAX_TOOL_PAYLOAD_CHARS,
} from './lib/tools/firecrawl';

// Events / trace
export { consoleTrace, type TraceEvent } from './lib/events/trace';

// Prompts
export { buildSystemPrompt } from './lib/prompts/system-prompt';
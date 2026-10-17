// @org/agent-core — host-agnostic agent runtime.
// Pure library: no HTTP, no DOM, no database.
// Domain types live in @org/agent-models — import them from there.

export { RESEARCH_MODE } from '@org/agent-models';

// Model layer
export { getClient } from './lib/model/client';
export { invokeModelTurn } from './lib/model/invoke';
export { streamModelTurn } from './lib/model/stream';
export { estimatePromptTokens } from './lib/model/estimate-prompt-tokens';
export { parseTokenUsage } from './lib/model/parse-usage';
export type { OnTextDelta, ModelCallOptions } from './lib/model/types';
export {
  getOllamaModelConfig,
  resolveReasoningEffort,
} from './lib/model/ollama-model-config';

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
export { createToolRegistry, ALL_TOOLS } from './lib/tools/registry';
export type { Tool, ToolGuidance, ToolRegistry } from './lib/tools/type';
export { toLedgerRecord } from './lib/loop/to-ledger-record';
export { webSearchTool, webFetchTool } from './lib/tools/web-search';

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
export {
  buildSystemPrompt,
  buildUserPersonaPrompt,
} from './lib/prompts/system-prompt';
export { loadAgentIdentity } from './lib/prompts/load-agent-identity';

// TraceEvent is defined in @agent/agent-models (domain types) so ToolContext,
// which lives in models, can reference it without inverting the dep direction.
// Re-exported here so core consumers keep importing from the events module tree.
export type { TraceEvent } from '@agent/agent-models';

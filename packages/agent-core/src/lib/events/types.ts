import type { AgentEvent } from '@agenticbot/agent-models';

/** Receives fully-formed agent events (with monotonic seq assigned by EventEmitter). */
export type EventSubscriber = (event: AgentEvent) => void;

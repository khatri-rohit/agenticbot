import type { AgentEvent } from '@org/agent-models';

/** Receives fully-formed agent events (with monotonic seq assigned by EventEmitter). */
export type EventSubscriber = (event: AgentEvent) => void;

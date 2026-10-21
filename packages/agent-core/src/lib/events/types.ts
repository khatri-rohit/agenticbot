import type { AgentEvent } from '@desk/agent-models';

/** Receives fully-formed agent events (with monotonic seq assigned by EventEmitter). */
export type EventSubscriber = (event: AgentEvent) => void;

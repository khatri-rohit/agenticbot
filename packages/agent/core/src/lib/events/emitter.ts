import type { AgentEvent, AgentEventWithoutSeq } from '@org/agent-models';

/** A subscriber receives fully-formed events (with seq assigned). */
export type EventSubscriber = (event: AgentEvent) => void;

/**
 * In-memory event emitter with monotonic seq counters and a ring buffer
 * for SSE reconnection replay.
 *
 * One emitter per run. When the run completes, the buffer can be cleared
 * (the client should have persisted events to its own IndexedDB by then).
 */
export class EventEmitter {
  private seq = 0;
  private buffer: AgentEvent[] = [];
  private subscribers = new Set<EventSubscriber>();

  /** Emit an event. Assigns seq, buffers, and fans out to subscribers. */
  emit(event: AgentEventWithoutSeq): void {
    const seq = ++this.seq;
    const fullEvent = { seq, ...event } as AgentEvent;
    this.buffer.push(fullEvent);
    for (const sub of this.subscribers) {
      sub(fullEvent);
    }
  }

  /** Subscribe to live events. Returns an unsubscribe function. */
  subscribe(subscriber: EventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  /** Get buffered events after the given seq (for replay on reconnect). */
  getEventsFromSeq(fromSeq: number): AgentEvent[] {
    return this.buffer.filter((e) => e.seq > fromSeq);
  }

  /** All buffered events. */
  getBuffer(): AgentEvent[] {
    return [...this.buffer];
  }

  /** Current seq (for clients to track their cursor). */
  get currentSeq(): number {
    return this.seq;
  }

  /** Clear the buffer (call after run completes and clients have persisted). */
  dispose(): void {
    this.buffer = [];
    this.subscribers.clear();
  }
}
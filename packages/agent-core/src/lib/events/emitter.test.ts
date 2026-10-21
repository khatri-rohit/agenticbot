import { describe, expect, it } from 'vitest';

import { EventEmitter, MAX_BUFFERED_EVENTS } from './emitter';

describe('EventEmitter', () => {
  it('assigns monotonic seq and keeps a bounded ring', () => {
    const emitter = new EventEmitter();
    const extra = 3;
    for (let i = 0; i < MAX_BUFFERED_EVENTS + extra; i++) {
      emitter.emit({ type: 'run.settled', runId: 'r1' });
    }

    const buffer = emitter.getBuffer();
    expect(buffer).toHaveLength(MAX_BUFFERED_EVENTS);
    expect(buffer[0]?.seq).toBe(extra + 1);
    expect(buffer[buffer.length - 1]?.seq).toBe(MAX_BUFFERED_EVENTS + extra);
    expect(emitter.currentSeq).toBe(MAX_BUFFERED_EVENTS + extra);
  });

  it('replays only seqs after fromSeq', () => {
    const emitter = new EventEmitter();
    emitter.emit({ type: 'run.settled', runId: 'r1' });
    emitter.emit({ type: 'run.settled', runId: 'r1' });
    emitter.emit({ type: 'run.settled', runId: 'r1' });

    expect(emitter.getEventsFromSeq(1).map((e) => e.seq)).toEqual([2, 3]);
  });
});

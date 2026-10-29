import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

import { TRACE_SCHEMA_VERSION } from '@agent/agent-models';
import type { TraceEvent } from '@agent/agent-core';

/**
 * Process-wide write chains and sequence numbers, keyed by trace file.
 * Several sinks write one run's file (the run's own, the post-run compaction
 * event, sub-agent hosts), so ordering cannot live in one sink instance.
 */
const tails = new Map<string, Promise<void>>();
const seqs = new Map<string, number>();
/** Runs whose `seq` counter is remembered; oldest are dropped past this. */
const MAX_TRACKED_RUNS = 2_000;

function nextSeq(file: string): number {
  const seq = (seqs.get(file) ?? 0) + 1;
  // Re-insert so the Map's order is least-recently-written first.
  seqs.delete(file);
  seqs.set(file, seq);
  if (seqs.size > MAX_TRACKED_RUNS) {
    const oldest = seqs.keys().next().value;
    if (oldest !== undefined) seqs.delete(oldest);
  }
  return seq;
}

/**
 * Append-only JSONL trace sink. One file per run under `<dir>/<runId>.jsonl`.
 * Each line is a TraceEvent stamped with `v` (schema version, so an offline
 * reader can parse old traces), `ts`, and `seq` (per-file emit order, since
 * several events share a millisecond). Writes to one file are chained, so
 * lines land in emit order. Failures are swallowed so a trace write never
 * kills a run.
 */
export function createJsonlTraceSink(dir: string): (event: TraceEvent) => void {
  const ready = mkdir(dir, { recursive: true }).catch(() => undefined);

  return (event) => {
    const file = path.join(dir, `${event.runId}.jsonl`);
    const line = JSON.stringify({
      v: TRACE_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      seq: nextSeq(file),
      ...event,
    });
    const tail = Promise.all([tails.get(file), ready]).then(() =>
      appendFile(file, `${line}\n`).catch(() => undefined),
    );
    tails.set(file, tail);
    // Drop the chain once idle so the map does not hold every run.
    void tail.then(() => {
      if (tails.get(file) === tail) tails.delete(file);
    });
  };
}

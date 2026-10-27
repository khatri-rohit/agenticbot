import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

import type { TraceEvent } from '@agent/agent-core';

/**
 * Append-only JSONL trace sink. One file per run under `<dir>/<runId>.jsonl`.
 * Each TraceEvent is written as a single line with an `ts` field for offline
 * replay ordering. Failures are swallowed so a trace write never kills a run.
 */
export function createJsonlTraceSink(dir: string): (event: TraceEvent) => void {
  const ready = mkdir(dir, { recursive: true }).catch(() => undefined);

  return (event) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...event });
    void ready.then(() =>
      appendFile(path.join(dir, `${event.runId}.jsonl`), `${line}\n`).catch(
        () => undefined,
      ),
    );
  };
}
import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

import { TRACE_SCHEMA_VERSION } from '@agent/agent-models';
import type { TraceEvent } from '@agent/agent-core';

/**
 * Append-only JSONL trace sink. One file per run under `<dir>/<runId>.jsonl`.
 * Each line is a TraceEvent stamped with `ts` (ordering) and `v` (schema
 * version, so an offline reader can parse old traces). Failures are swallowed
 * so a trace write never kills a run.
 */
export function createJsonlTraceSink(dir: string): (event: TraceEvent) => void {
  const ready = mkdir(dir, { recursive: true }).catch(() => undefined);

  return (event) => {
    const line = JSON.stringify({
      v: TRACE_SCHEMA_VERSION,
      ts: new Date().toISOString(),
      ...event,
    });
    void ready.then(() =>
      appendFile(path.join(dir, `${event.runId}.jsonl`), `${line}\n`).catch(
        () => undefined,
      ),
    );
  };
}

import { readFile } from 'node:fs/promises';

import type { TraceEvent } from '@agent/agent-models';

/**
 * One trace line. The JSONL sink (apps/api/src/lib/trace-sink.ts) stamps
 * `v`, `ts` and `seq` on each line; they are not part of TraceEvent. Read
 * timing and order from here, never from fields the event union lacks.
 */
export type TraceLine = TraceEvent & { v?: number; ts?: string; seq?: number };

export type ParsedTrace = {
  lines: TraceLine[];
  /** Lines skipped because they were not JSON or had no `type`. */
  warnings: number;
};

/** A line of a given event type, with the sink's stamps. */
export type TraceLineOf<T extends TraceEvent['type']> = Extract<TraceEvent, { type: T }> & {
  v?: number;
  ts?: string;
  seq?: number;
};

export function linesOf<T extends TraceEvent['type']>(
  lines: TraceLine[],
  type: T,
): TraceLineOf<T>[] {
  return lines.filter((line) => line.type === type) as TraceLineOf<T>[];
}

/**
 * Parse text from one run's `<runId>.jsonl`. Ordered by `seq` when every
 * line has one (older traces may not), else file order. Unknown event types
 * are kept as-is so newer traces still load; consumers switch on known types.
 * Never throws.
 */
export function parseTrace(text: string): ParsedTrace {
  const parsed: TraceLine[] = [];
  let warnings = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const value = JSON.parse(raw) as unknown;
      if (
        !value ||
        typeof value !== 'object' ||
        typeof (value as { type?: unknown }).type !== 'string'
      ) {
        warnings += 1;
        continue;
      }
      parsed.push(value as TraceLine);
    } catch {
      warnings += 1;
    }
  }
  if (parsed.length > 0 && parsed.every((line) => typeof line.seq === 'number')) {
    parsed.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }
  return { lines: parsed, warnings };
}

/** Read and parse a trace file. A missing file is an empty trace. */
export async function readRunTrace(file: string): Promise<ParsedTrace> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { lines: [], warnings: 0 };
  }
  return parseTrace(text);
}

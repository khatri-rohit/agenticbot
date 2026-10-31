import { readFile } from 'node:fs/promises';
import type { TraceEvent } from '@agent/agent-models';

/**
 * Parsed trace file: events sorted by seq, plus a warnings count for
 * corrupt/unparseable lines. Unknown event types are kept as `{ type:
 * 'unknown', raw }` so consumers can detect schema drift without crashing.
 */
export type ParsedTrace = {
  events: (TraceEvent | { type: 'unknown'; raw: unknown })[];
  warnings: number;
};

type RawLine = {
  v?: number;
  ts?: string;
  seq?: number;
  type?: string;
} & Record<string, unknown>;

/**
 * Parse a JSONL trace file (one run's `<runId>.jsonl`). The sink stamps each
 * line with `v`, `ts`, and `seq` (per-file emit order). We sort by `seq` when
 * present, otherwise keep file order. Corrupt lines are skipped and counted.
 */
export async function readRunTrace(file: string): Promise<ParsedTrace> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { events: [], warnings: 0 };
  }

  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const parsed: { seq: number | null; event: TraceEvent | { type: 'unknown'; raw: unknown } }[] = [];
  let warnings = 0;

  for (const line of lines) {
    try {
      const raw = JSON.parse(line) as RawLine;
      if (!raw.type || typeof raw.type !== 'string') {
        warnings++;
        continue;
      }
      const { v: _v, ts: _ts, seq, ...event } = raw;
      parsed.push({
        seq: typeof seq === 'number' ? seq : null,
        event: event as TraceEvent,
      });
    } catch {
      warnings++;
    }
  }

  // Sort by seq when every entry has it; otherwise keep file order.
  if (parsed.length > 0 && parsed.every((p) => p.seq !== null)) {
    parsed.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  return { events: parsed.map((p) => p.event), warnings };
}
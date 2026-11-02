import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { LedgerEnvelope } from '@agent/agent-models';

export type ParsedLedger = {
  envelopes: LedgerEnvelope[];
  /** Lines skipped because they were not JSON. */
  warnings: number;
};

/** A thread's `ledger.jsonl` in append order. A missing file is an empty ledger. */
export async function readLedger(home: string, threadId: string): Promise<ParsedLedger> {
  let text: string;
  try {
    text = await readFile(path.join(home, 'sessions', threadId, 'ledger.jsonl'), 'utf8');
  } catch {
    return { envelopes: [], warnings: 0 };
  }
  const envelopes: LedgerEnvelope[] = [];
  let warnings = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      envelopes.push(JSON.parse(line) as LedgerEnvelope);
    } catch {
      warnings += 1;
    }
  }
  return { envelopes, warnings };
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { LedgerEnvelope } from '@agent/agent-models';

/**
 * Read a thread's ledger.jsonl — the durable truth that the UI rebuilds from.
 * Returns envelopes in file order (append order). Corrupt lines are skipped.
 */
export async function readLedger(
  home: string,
  threadId: string,
): Promise<LedgerEnvelope[]> {
  const file = path.join(home, 'sessions', threadId, 'ledger.jsonl');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }

  const envelopes: LedgerEnvelope[][] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      envelopes.push([JSON.parse(line) as LedgerEnvelope]);
    } catch {
      // Skip corrupt lines — the ledger is append-only and never partial.
    }
  }
  return envelopes.flat();
}
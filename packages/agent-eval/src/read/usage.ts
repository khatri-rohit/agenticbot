import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { RunUsage } from '@agent/agent-models';

/** Balance point as written by apps/api/src/models/capacity.ts (`balancePoint`). */
export type UsageBalancePoint =
  | { sessionRemainingPercent: number; weeklyRemainingPercent: number }
  | { balanceUsd: number; allowanceUsd: number; purchasedUsd?: number };

/** One line of `$AGENT_HOME/usage/usage.jsonl` (`appendUsageLog`). */
export type UsageRecord = {
  ts: string;
  runId: string;
  threadId: string;
  model: string;
  endpoint: string;
  status: string;
  limitReason?: string;
  usage?: RunUsage;
  balanceBefore: UsageBalancePoint | null;
  balanceAfter: UsageBalancePoint | null;
  capacity: 'open' | 'conserve' | 'pause';
};

export type ParsedUsage = { records: UsageRecord[]; warnings: number };

/** The usage log, one record per finished run. A fresh home has none. */
export async function readUsage(home: string): Promise<ParsedUsage> {
  let text: string;
  try {
    text = await readFile(path.join(home, 'usage', 'usage.jsonl'), 'utf8');
  } catch {
    return { records: [], warnings: 0 };
  }
  const records: UsageRecord[] = [];
  let warnings = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as UsageRecord);
    } catch {
      warnings += 1;
    }
  }
  return { records, warnings };
}

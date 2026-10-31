import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * One row from `$AGENT_HOME/usage/usage.jsonl`. Written by the API's
 * appendUsageLog (apps/api/src/lib/capacity.ts). Shape is a superset of
 * what we need for capacity monitoring; we keep it loose.
 */
export type UsageRecord = {
  ts: string;
  runId: string;
  threadId: string;
  model: string;
  endpoint: string;
  status: string;
  limitReason?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
    ownPromptTokens?: number;
    childPromptTokens?: number;
  };
  balanceBefore?: { percent?: number };
  balanceAfter?: { percent?: number };
  capacity?: string;
};

/**
 * Read the usage log. One line per finished run. Best-effort: missing file
 * returns empty array (a fresh home has no usage yet).
 */
export async function readUsage(home: string): Promise<UsageRecord[]> {
  const file = path.join(home, 'usage', 'usage.jsonl');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }

  const records: UsageRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line) as UsageRecord);
    } catch {
      // Skip corrupt lines.
    }
  }
  return records;
}
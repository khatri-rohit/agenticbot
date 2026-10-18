import type { LedgerEnvelope, Snapshot } from '@org/agent-models';

const BRIEF_MAX = 1_200;
const SUMMARY_MAX = 8_000;
const TURN_MAX = 400;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}…`;
}

function recordText(envelope: LedgerEnvelope): string {
  const { record } = envelope;
  if (record.role === 'user') return record.content;
  if (record.role === 'assistant') return record.content ?? '';
  return '';
}

/**
 * Compact everything before the last `keepUserTurns` user messages.
 * Returns null when the live tail already covers the whole ledger.
 */
export function chooseCompactThroughSeq(
  envelopes: LedgerEnvelope[],
  keepUserTurns: number,
): number | null {
  const users = envelopes.filter((envelope) => envelope.record.role === 'user');
  if (users.length <= keepUserTurns) return null;
  const firstLive = users[users.length - keepUserTurns];
  const throughSeq = firstLive.seq - 1;
  if (throughSeq < 1) return null;
  return throughSeq;
}

/**
 * Deterministic recap of compacted turns. Never rewrites USER/MEMORY/AGENTS
 * (those are not ledger rows). Tool payloads are omitted.
 */
export function buildExtractiveSnapshot(input: {
  threadId: string;
  model: string;
  envelopes: LedgerEnvelope[];
  throughSeq: number;
}): Snapshot {
  const compacted = input.envelopes.filter(
    (envelope) => envelope.seq <= input.throughSeq,
  );
  const users = compacted.filter((envelope) => envelope.record.role === 'user');
  const lastUser = users.at(-1);
  const briefParts = [
    lastUser
      ? `Goal: ${clip(recordText(lastUser), 280)}`
      : 'Goal: (none recorded)',
  ];
  const prior = users.slice(-3, -1);
  if (prior.length > 0) {
    briefParts.push(
      'Earlier questions:',
      ...prior.map((envelope) => `- ${clip(recordText(envelope), 160)}`),
    );
  }
  const brief = clip(briefParts.join('\n'), BRIEF_MAX);

  const summaryLines: string[] = [];
  for (const envelope of compacted) {
    if (
      envelope.record.role !== 'user' &&
      envelope.record.role !== 'assistant'
    ) {
      continue;
    }
    const text = clip(recordText(envelope), TURN_MAX);
    if (!text) continue;
    const label = envelope.record.role === 'user' ? 'User' : 'Assistant';
    summaryLines.push(`${label}: ${text}`);
  }

  return {
    threadId: input.threadId,
    throughSeq: input.throughSeq,
    model: input.model,
    brief,
    summary: clip(summaryLines.join('\n\n'), SUMMARY_MAX),
    createdAt: new Date().toISOString(),
  };
}

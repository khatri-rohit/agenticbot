import type { LedgerEnvelope, Snapshot } from '@desk/agent-models';

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
  const facts = collectToolFacts(compacted);
  if (facts.files.length > 0) {
    briefParts.push(`Files: ${facts.files.join(', ')}`);
  }
  if (facts.commands.length > 0) {
    briefParts.push(
      `Commands: ${facts.commands.map((command) => clip(command, 80)).join(' | ')}`,
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

const MENTION_MAX_CHARS = 4_000;

function collectToolFacts(envelopes: LedgerEnvelope[]): {
  files: string[];
  commands: string[];
} {
  const files: string[] = [];
  const seenFiles = new Set<string>();
  const commands: string[] = [];
  for (const envelope of envelopes) {
    if (envelope.record.role !== 'assistant') continue;
    for (const call of envelope.record.tool_calls ?? []) {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(call.function.arguments) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        continue;
      }
      if (typeof args.path === 'string' && args.path.trim()) {
        const filePath = args.path.trim();
        if (!seenFiles.has(filePath)) {
          seenFiles.add(filePath);
          files.push(filePath);
        }
      }
      if (
        call.function.name === 'run_terminal' &&
        typeof args.command === 'string' &&
        args.command.trim()
      ) {
        commands.push(args.command.trim());
      }
    }
  }
  return { files: files.slice(-8), commands: commands.slice(-4) };
}

/** Budgeted extract of another thread for the mentions layer. Re-extracted at run time. */
export function packMentionedThread(input: {
  title: string;
  sourceLabel: string;
  envelopes: LedgerEnvelope[];
  snapshot: Snapshot | null;
}): string {
  const throughSeq =
    chooseCompactThroughSeq(input.envelopes, 2) ??
    (input.envelopes.at(-1)?.seq ?? 0);
  const snapshot =
    input.snapshot && input.snapshot.throughSeq > 0
      ? input.snapshot
      : throughSeq > 0
        ? buildExtractiveSnapshot({
            threadId: 'mention',
            model: '',
            envelopes: input.envelopes,
            throughSeq,
          })
        : null;
  const live = input.envelopes.filter(
    (envelope) => envelope.seq > (snapshot?.throughSeq ?? 0),
  );
  const liveLines: string[] = [];
  for (const envelope of live) {
    if (
      envelope.record.role !== 'user' &&
      envelope.record.role !== 'assistant'
    ) {
      continue;
    }
    const text = recordText(envelope);
    if (!text) continue;
    const label = envelope.record.role === 'user' ? 'User' : 'Assistant';
    liveLines.push(`${label}: ${clip(text, 280)}`);
  }
  const parts = [
    `Thread: ${input.title}`,
    `Source: ${input.sourceLabel}`,
    snapshot?.brief ? `Brief:\n${snapshot.brief}` : '',
    snapshot?.summary ? `Earlier:\n${clip(snapshot.summary, 2_000)}` : '',
    liveLines.length > 0 ? `Recent:\n${liveLines.join('\n')}` : '',
  ].filter(Boolean);
  return clip(parts.join('\n\n'), MENTION_MAX_CHARS);
}

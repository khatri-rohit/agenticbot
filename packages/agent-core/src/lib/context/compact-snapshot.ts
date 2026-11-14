import {
  CHARS_PER_TOKEN,
  compactionMarks,
  type ContextReport,
  type LedgerEnvelope,
  type Snapshot,
} from '@agent/agent-models';

const BRIEF_MAX = 1_200;
const SUMMARY_MAX = 8_000;
const TURN_MAX = 400;
const OMITTED_MARKER_MAX = 40;

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

function envelopeChars(envelope: LedgerEnvelope): number {
  const { record } = envelope;
  if (record.role === 'assistant') {
    return (record.content ?? '').length + JSON.stringify(record.tool_calls ?? []).length;
  }
  return 'content' in record && typeof record.content === 'string' ? record.content.length : 0;
}

/**
 * Like chooseCompactThroughSeq, but keeps cutting older turns (down to the
 * last one) until the live tail fits `targetTokens`. A single oversized turn
 * cannot be split here; in-run compaction handles that case.
 */
export function chooseCompactThroughSeqForTarget(
  envelopes: LedgerEnvelope[],
  keepUserTurns: number,
  targetTokens: number,
): number | null {
  for (let keep = keepUserTurns; keep >= 1; keep--) {
    const throughSeq = chooseCompactThroughSeq(envelopes, keep);
    if (throughSeq === null) continue;
    const tailChars = envelopes
      .filter((envelope) => envelope.seq > throughSeq)
      .reduce((sum, envelope) => sum + envelopeChars(envelope), 0);
    if (tailChars / CHARS_PER_TOKEN <= targetTokens || keep === 1) return throughSeq;
  }
  return null;
}

/**
 * The compaction decision (no LLM): when the report is over the compaction
 * mark, the last seq to fold into the snapshot so the remaining history
 * fits the target next to the fixed layers (both from `compactionMarks`:
 * the lower of a window share and an absolute figure). Null when nothing
 * should be cut.
 */
export function planCompaction(
  envelopes: LedgerEnvelope[],
  report: ContextReport,
): number | null {
  if (!report.needsCompaction) return null;
  const { budget, layers, occupiedTokens } = report;
  const historyTokens =
    layers.find((layer) => layer.id === 'conversation')?.tokens ?? 0;
  const fixedTokens = Math.max(0, occupiedTokens - historyTokens);
  const targetTokens = Math.max(1, compactionMarks(budget).to - fixedTokens);
  return chooseCompactThroughSeqForTarget(
    envelopes,
    budget.keepToolResultsForTurns,
    targetTokens,
  );
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
    summary: keepFirstAndNewest(summaryLines, SUMMARY_MAX),
    createdAt: new Date().toISOString(),
  };
}

/**
 * Fit turn lines in `max` chars keeping the first line (the request that
 * started the thread) and as many of the newest as fit. The turns right
 * before the cut are the ones a follow-up depends on; a head clip dropped
 * exactly those.
 */
function keepFirstAndNewest(lines: string[], max: number): string {
  const all = lines.join('\n\n');
  if (all.length <= max) return all;
  const first = lines[0] ?? '';
  const newest: string[] = [];
  let used = first.length;
  for (let i = lines.length - 1; i > 0; i--) {
    const line = lines[i] ?? '';
    // Each kept line costs its text plus a separator; reserve room for the marker.
    if (used + line.length + 2 + OMITTED_MARKER_MAX > max) break;
    newest.unshift(line);
    used += line.length + 2;
  }
  const omitted = lines.length - 1 - newest.length;
  const marker = omitted > 0 ? [`(${omitted} earlier turns omitted)`] : [];
  return clip([first, ...marker, ...newest].join('\n\n'), max);
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

/**
 * The full text of the turns a snapshot folds (seq <= throughSeq), for the
 * host to store as a blob: every user and assistant message, each tool call
 * with its arguments, and each tool result in full, or its own blob's sha
 * when it was offloaded. The summary is lossy by design; this keeps the
 * folded turns restorable (`recall`), so compaction removes text from the
 * prompt without removing it from reach (P4).
 */
export function foldedTranscript(envelopes: LedgerEnvelope[], throughSeq: number): string {
  const lines: string[] = [`Earlier turns of this thread, through ledger seq ${throughSeq}, oldest first.`];
  for (const envelope of envelopes) {
    if (envelope.seq > throughSeq) continue;
    const { record } = envelope;
    if (record.role === 'user') {
      lines.push('', `## User (seq ${envelope.seq})`, record.content);
    } else if (record.role === 'assistant') {
      lines.push('', `## Assistant (seq ${envelope.seq})`);
      if (record.content) lines.push(record.content);
      for (const call of record.tool_calls ?? []) {
        if (call.type === 'function') lines.push(`[call ${call.id}] ${call.function.name} ${call.function.arguments}`);
      }
    } else if (record.role === 'tool') {
      lines.push(
        '',
        `## Tool result ${record.tool_call_id} (seq ${envelope.seq})`,
        envelope.contentBlob ? `(stored: recall sha256:${envelope.contentBlob})` : record.content,
      );
    }
  }
  return lines.join('\n');
}

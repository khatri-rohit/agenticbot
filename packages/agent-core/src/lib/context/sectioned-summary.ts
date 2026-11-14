import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { LedgerEnvelope, Snapshot } from '@agent/agent-models';

import { buildEvidenceLog } from './situation';

/**
 * Sectioned summary for between-run compaction: one bounded model call over
 * the compacted turns. Pure here; the host makes the call and falls back to
 * the extractive snapshot when it fails, times out, or the reply is not in
 * shape. Tool results are not sent (only user/assistant text and the
 * harness evidence log), so fetched pages cannot steer the summary.
 */

export const SUMMARY_SECTIONS = [
  'Goal',
  'Constraints and preferences',
  'Progress',
  'Decisions',
  'Relevant files',
  'Next steps',
  'Critical context',
] as const;

const TURN_MAX_CHARS = 1_200;
const TRANSCRIPT_MAX_CHARS = 40_000;
const SUMMARY_MAX_CHARS = 8_000;

const INSTRUCTION = [
  'You compress the earlier part of a conversation between a user and an AI agent into a summary the agent will rely on in later turns.',
  `Write exactly these sections as markdown headings, in this order: ${SUMMARY_SECTIONS.map((name) => `## ${name}`).join(', ')}.`,
  'Use only what the transcript states. Write "none" under a section with nothing to say.',
  "Quote the user's constraints and preferences word for word.",
  'Prefer the newest information when turns disagree, and say what changed.',
  'Under 600 words. No preamble.',
].join('\n');

function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function turnText(envelope: LedgerEnvelope): string | null {
  const { record } = envelope;
  if (record.role === 'user') return `User: ${clip(record.content, TURN_MAX_CHARS)}`;
  if (record.role === 'assistant' && record.content) {
    return `Assistant: ${clip(record.content, TURN_MAX_CHARS)}`;
  }
  return null;
}

/** Keep the first turn and as many of the newest as fit. */
function fitTranscript(lines: string[]): string {
  const first = lines[0] ?? '';
  const newest: string[] = [];
  let used = first.length;
  for (let i = lines.length - 1; i > 0; i--) {
    const line = lines[i] ?? '';
    if (used + line.length + 2 > TRANSCRIPT_MAX_CHARS) break;
    newest.unshift(line);
    used += line.length + 2;
  }
  const omitted = lines.length - 1 - newest.length;
  return [first, ...(omitted > 0 ? [`(${omitted} turns omitted)`] : []), ...newest].join('\n\n');
}

export function buildSummaryMessages(input: {
  envelopes: LedgerEnvelope[];
  throughSeq: number;
  previous: Snapshot | null;
}): ChatCompletionMessageParam[] {
  const compacted = input.envelopes.filter((envelope) => envelope.seq <= input.throughSeq);
  const transcript = fitTranscript(
    compacted.map(turnText).filter((line): line is string => line !== null),
  );
  const evidence = buildEvidenceLog(compacted);
  const parts = [
    ...(input.previous?.summary
      ? [`Earlier summary (update it; keep what still holds):\n${input.previous.summary}`]
      : []),
    `Transcript:\n${transcript}`,
    ...(evidence ? [evidence] : []),
  ];
  return [
    { role: 'system', content: INSTRUCTION },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/**
 * The model's reply as a snapshot summary, or null when it is not in shape
 * (missing sections). The header marks it as model-written: the agent is
 * told to check file contents instead of trusting it as a record.
 */
export function acceptSectionedSummary(reply: string, throughSeq: number): string | null {
  const text = reply.trim();
  const missing = SUMMARY_SECTIONS.filter(
    (name) => !new RegExp(`^##\\s+${name}\\s*$`, 'im').test(text),
  );
  // Tolerate one dropped section; more means the model did not follow the shape.
  if (missing.length > 1) return null;
  const header = `(Model-written summary of turns through ledger seq ${throughSeq}. Re-read files before relying on their contents.)`;
  return clip(`${header}\n\n${text}`, SUMMARY_MAX_CHARS);
}

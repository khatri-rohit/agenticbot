import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { LedgerEnvelope, MemoryFiles, ProposedMemoryOp } from '@agent/agent-models';

/**
 * Learning-loop review: after a thread goes idle, one bounded model call
 * reads the new user/assistant turns (never tool output) and the current
 * memory, and proposes durable facts. Pure here; the host makes the call,
 * runs the gate, and stages every proposal for the user's approval.
 */

const MAX_PROPOSALS = 5;
const TURN_MAX_CHARS = 1_000;
const TRANSCRIPT_MAX_CHARS = 24_000;
const CONTENT_MAX_CHARS = 300;

const INSTRUCTION = [
  'You maintain the long-term memory of a personal AI agent. Read the new conversation turns and propose facts worth keeping across future conversations.',
  'Propose only durable facts: who the user is, stable preferences for how the agent should work, corrections the user made to the agent, and environment or project conventions.',
  'Do not propose anything already in the current memory, anything only true for this one task, guesses, or secrets.',
  'target "user" = a fact about the user. target "notes" = a working lesson or convention.',
  'evidence "user-said" = the user stated it. evidence "observed" = you inferred it from what happened.',
  `Reply with JSON only: {"proposals":[{"target":"user"|"notes","content":"one short sentence","reason":"why it lasts","evidence":"user-said"|"observed"}]}. At most ${MAX_PROPOSALS}. Use {"proposals":[]} when nothing qualifies.`,
].join('\n');

function clip(text: string, max: number): string {
  const flat = text.trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** User/assistant turns after `afterSeq`, newest kept when over budget. */
function transcriptAfter(envelopes: LedgerEnvelope[], afterSeq: number): string {
  const lines: string[] = [];
  for (const envelope of envelopes) {
    if (envelope.seq <= afterSeq) continue;
    const { record } = envelope;
    if (record.role === 'user') lines.push(`User: ${clip(record.content, TURN_MAX_CHARS)}`);
    else if (record.role === 'assistant' && record.content) {
      lines.push(`Assistant: ${clip(record.content, TURN_MAX_CHARS)}`);
    }
  }
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    if (used + line.length > TRANSCRIPT_MAX_CHARS) break;
    kept.unshift(line);
    used += line.length + 2;
  }
  return kept.join('\n\n');
}

/** Number of user turns after `afterSeq` (the host skips a review with too few). */
export function newUserTurns(envelopes: LedgerEnvelope[], afterSeq: number): number {
  return envelopes.filter((envelope) => envelope.seq > afterSeq && envelope.record.role === 'user').length;
}

export function buildReviewMessages(input: {
  envelopes: LedgerEnvelope[];
  afterSeq: number;
  memory: MemoryFiles;
}): ChatCompletionMessageParam[] {
  const memory = [
    `USER.md:\n${input.memory.user.trim() || '(empty)'}`,
    `MEMORY.md:\n${input.memory.notes.trim() || '(empty)'}`,
  ].join('\n\n');
  return [
    { role: 'system', content: INSTRUCTION },
    {
      role: 'user',
      content: `Current memory:\n${memory}\n\nNew turns:\n${transcriptAfter(input.envelopes, input.afterSeq)}`,
    },
  ];
}

/**
 * Proposals from the model's reply, as `add` ops by `review`. Anything not in
 * shape is dropped, never repaired. Returns [] for an unusable reply.
 */
export function parseReviewProposals(
  reply: string,
  source: { threadId: string; seq: number },
): ProposedMemoryOp[] {
  const json = reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const list = (parsed as { proposals?: unknown })?.proposals;
  if (!Array.isArray(list)) return [];
  const ops: ProposedMemoryOp[] = [];
  for (const item of list.slice(0, MAX_PROPOSALS)) {
    if (!item || typeof item !== 'object') continue;
    const { target, content, reason, evidence } = item as Record<string, unknown>;
    if (target !== 'user' && target !== 'notes') continue;
    if (typeof content !== 'string' || !content.trim()) continue;
    if (typeof reason !== 'string' || !reason.trim()) continue;
    ops.push({
      target,
      action: 'add',
      content: clip(content, CONTENT_MAX_CHARS),
      reason: clip(reason, CONTENT_MAX_CHARS),
      source,
      by: 'review',
      evidence: evidence === 'user-said' ? 'user-said' : 'observed',
    });
  }
  return ops;
}

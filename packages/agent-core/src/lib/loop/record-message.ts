import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { CHARS_PER_TOKEN, type TaskFinding } from '@agent/agent-models';

import { recordSection } from '../state/record-view';

/**
 * The run's task record in the prompt history (v2 phase 7, F-6). The card
 * is appended after everything else on every call, so whatever it carries
 * is re-sent uncached every call. The record changes only when a finding is
 * recorded, so at each prompt boundary the harness writes it once into the
 * history as this message (cached until the next boundary) and the card
 * carries only the findings recorded since. Prompt-only: it never reaches
 * the ledger, and the next boundary replaces it.
 */
export const RECORD_MESSAGE_PREFIX =
  "[Task record: this run's findings so far, written by the harness at its last prompt boundary, not from the user]";

export function isRecordMessage(message: ChatCompletionMessageParam | undefined): boolean {
  return message?.role === 'user' && typeof message.content === 'string' && message.content.startsWith(RECORD_MESSAGE_PREFIX);
}

/** Drop the run's record message(s) from the live prompt; returns how many. */
export function removeRecordMessages(messages: ChatCompletionMessageParam[], runStart: number): number {
  let removed = 0;
  for (let i = messages.length - 1; i >= runStart; i--) {
    if (isRecordMessage(messages[i])) {
      messages.splice(i, 1);
      removed += 1;
    }
  }
  return removed;
}

function recordHeader(count: number): string {
  return `${count} finding(s); answer from these and cite their evidence. Findings recorded after this point are on the harness card.`;
}

/** The record message for these findings, within `tokens` (the full record behind `blobSha` when it does not fit). */
export function recordMessage(findings: TaskFinding[], tokens: number, blobSha?: string): ChatCompletionMessageParam {
  return {
    role: 'user',
    content: [RECORD_MESSAGE_PREFIX, ...recordSection(findings, tokens, blobSha, recordHeader)].join('\n'),
  };
}

/** Tokens the card spends on findings recorded after the record message. */
export function recordDeltaTokens(findings: TaskFinding[], recordedThrough: number): number {
  let chars = 0;
  for (const finding of findings.slice(recordedThrough)) {
    chars += finding.claim.length + finding.evidence.length + (finding.topic?.length ?? 0) + 8;
  }
  return chars / CHARS_PER_TOKEN;
}

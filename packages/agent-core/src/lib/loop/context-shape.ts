import { createHash } from 'node:crypto';

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

import { CHARS_PER_TOKEN } from '@agent/agent-models';

import { CARD_PREFIX } from '../context/residency';
import { CARD_HEADER } from './state-card';

export type ContextShape = {
  messages: number;
  promptTokens: number;
  residentToolTokens: number;
  residueTokens: number;
  prefixStableMessages: number;
  /** The harness card on this call: the last user message, when it starts with CARD_HEADER; else 0. */
  cardTokens: number;
};

function text(content: ChatCompletionMessageParam['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => ('text' in part && typeof part.text === 'string' ? part.text : '')).join('');
}

function callArgs(message: ChatCompletionMessageParam): string {
  if (message.role !== 'assistant' || !message.tool_calls) return '';
  return message.tool_calls
    .map((call) => ('function' in call ? `${call.function.name}${call.function.arguments}` : ''))
    .join('');
}

/** A short fingerprint of one message, to compare prompts call to call. */
function messageKey(message: ChatCompletionMessageParam): string {
  return createHash('sha1')
    .update(`${message.role}\u0000${text(message.content)}\u0000${callArgs(message)}`)
    .digest('base64');
}

const tokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);

/**
 * What one model call is made of (phase-0 measurement; changes nothing).
 * Resident: this run's tool results still in full. Residue: what can no
 * longer leave the prompt (cards of removed results, plus the argument
 * text of this run's earlier tool calls). Prefix stability: leading
 * messages identical to the previous call's, the part a cache can reuse.
 * Returns the message keys for the next call's comparison.
 */
export function measureContextShape(
  sent: ChatCompletionMessageParam[],
  runStart: number,
  previousKeys: readonly string[],
): { shape: ContextShape; keys: string[] } {
  let total = 0;
  let resident = 0;
  let residue = 0;
  const keys: string[] = [];
  sent.forEach((message, index) => {
    const body = text(message.content);
    const args = callArgs(message);
    total += body.length + args.length;
    keys.push(messageKey(message));
    if (index < runStart) return;
    if (message.role === 'tool') {
      if (body.startsWith(CARD_PREFIX)) residue += body.length;
      else resident += body.length;
    } else if (args) {
      residue += args.length;
    }
  });
  let card = 0;
  for (let i = sent.length - 1; i >= 0; i--) {
    const message = sent[i]!;
    if (message.role !== 'user') continue;
    const body = text(message.content);
    if (body.startsWith(CARD_HEADER)) card = body.length;
    break;
  }
  let stable = 0;
  while (stable < keys.length && stable < previousKeys.length && keys[stable] === previousKeys[stable]) {
    stable += 1;
  }
  return {
    shape: {
      messages: sent.length,
      promptTokens: tokens(total),
      residentToolTokens: tokens(resident),
      residueTokens: tokens(residue),
      prefixStableMessages: stable,
      cardTokens: tokens(card),
    },
    keys,
  };
}

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';

import type { TaskFinding } from '@agent/agent-models';

import {
  isRecordMessage,
  recordDeltaTokens,
  recordMessage,
  RECORD_MESSAGE_PREFIX,
  removeRecordMessages,
} from './record-message';

const finding = (claim: string): TaskFinding => ({ claim, evidence: 'src/a.ts:1', iteration: 1, verification: 'verified' });

describe('task record message', () => {
  it('renders the findings under its prefix, and is recognised as one', () => {
    const message = recordMessage([finding('Port is 3000')], 1_000);
    expect(message.role).toBe('user');
    expect(String(message.content).startsWith(RECORD_MESSAGE_PREFIX)).toBe(true);
    expect(String(message.content)).toContain('- Port is 3000 — src/a.ts:1');
    expect(isRecordMessage(message)).toBe(true);
    expect(isRecordMessage({ role: 'user', content: 'a user turn' })).toBe(false);
  });

  it('is removed from the run region only, so a boundary can write it fresh', () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: 's' },
      recordMessage([finding('from an earlier boundary')], 1_000),
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'step' },
      recordMessage([finding('a')], 1_000),
    ];
    expect(removeRecordMessages(messages, 2)).toBe(1);
    expect(messages).toHaveLength(4);
    expect(isRecordMessage(messages[1])).toBe(true);
  });

  it('measures what the card spends on findings newer than the message', () => {
    const findings = [finding('a'.repeat(400)), finding('b'.repeat(400))];
    expect(recordDeltaTokens(findings, 2)).toBe(0);
    expect(recordDeltaTokens(findings, 1)).toBeGreaterThan(100);
    expect(recordDeltaTokens(findings, 0)).toBeGreaterThan(recordDeltaTokens(findings, 1));
  });
});

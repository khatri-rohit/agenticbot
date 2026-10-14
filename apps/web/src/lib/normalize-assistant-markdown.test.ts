import { describe, expect, it } from 'vitest';
import { normalizeAssistantMarkdown } from './normalize-assistant-markdown';

describe('normalizeAssistantMarkdown', () => {
  it('promotes a standalone bold line to a heading', () => {
    const input = [
      '**Article 1: ReAct Agentic Harness**',
      'ReAct is thought then action.',
    ].join('\n');

    expect(normalizeAssistantMarkdown(input)).toBe(
      [
        '### Article 1: ReAct Agentic Harness',
        'ReAct is thought then action.',
      ].join('\n'),
    );
  });

  it('does not rewrite bold text inside fenced code', () => {
    const input = ['```', '**not a heading**', '```'].join('\n');
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });

  it('leaves inline bold in a paragraph alone', () => {
    const input = 'ReAct is **thought** then action.';
    expect(normalizeAssistantMarkdown(input)).toBe(input);
  });
});

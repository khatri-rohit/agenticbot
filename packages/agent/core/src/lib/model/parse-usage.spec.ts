import { describe, expect, it } from 'vitest';

import { parseTokenUsage } from './parse-usage.js';

describe('parseTokenUsage', () => {
  it('maps OpenAI-compat usage fields', () => {
    expect(
      parseTokenUsage({
        prompt_tokens: 1200,
        completion_tokens: 40,
        total_tokens: 1240,
      }),
    ).toEqual({
      promptTokens: 1200,
      completionTokens: 40,
      totalTokens: 1240,
    });
  });

  it('returns undefined when prompt_tokens is missing', () => {
    expect(parseTokenUsage({})).toBeUndefined();
    expect(parseTokenUsage(null)).toBeUndefined();
    expect(parseTokenUsage({ completion_tokens: 10 })).toBeUndefined();
  });

  it('defaults completion_tokens to 0 when absent', () => {
    expect(parseTokenUsage({ prompt_tokens: 10 })).toEqual({
      promptTokens: 10,
      completionTokens: 0,
    });
  });
});

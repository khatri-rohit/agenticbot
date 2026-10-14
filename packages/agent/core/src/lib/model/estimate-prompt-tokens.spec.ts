import { describe, expect, it } from 'vitest';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';

import { estimatePromptTokens } from './estimate-prompt-tokens.js';

describe('estimatePromptTokens', () => {
  it('prices system + messages + tool schemas, not chat text alone', () => {
    const system = 'x'.repeat(400); // 100 tokens
    const tools: ChatCompletionTool[] = [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'y'.repeat(40),
          parameters: { type: 'object', properties: {} },
        },
      },
    ];
    const messagesOnly = estimatePromptTokens([
      { role: 'user', content: 'hello world' },
    ]);
    const withSystem = estimatePromptTokens([
      { role: 'system', content: system },
      { role: 'user', content: 'hello world' },
    ]);
    const full = estimatePromptTokens(
      [
        { role: 'system', content: system },
        { role: 'user', content: 'hello world' },
      ],
      tools,
    );

    expect(withSystem).toBeGreaterThan(messagesOnly);
    expect(full).toBeGreaterThan(withSystem);
    expect(full).toBeGreaterThanOrEqual(100);
  });

  it('counts image_url parts with a fixed allowance', () => {
    const textOnly = estimatePromptTokens([
      { role: 'user', content: 'see this' },
    ]);
    const withImage = estimatePromptTokens([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see this' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,abc' },
          },
        ],
      },
    ]);
    expect(withImage).toBeGreaterThanOrEqual(textOnly + 1000);
  });
});

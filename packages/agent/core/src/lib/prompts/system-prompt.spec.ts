import { describe, expect, it } from 'vitest';
import { buildUserPersonaPrompt } from './system-prompt.js';

describe('buildUserPersonaPrompt', () => {
  it('does not invent a biography when empty', () => {
    const text = buildUserPersonaPrompt();
    expect(text).toContain('No frozen user profile');
    expect(text).toContain('Do not invent a biography');
  });

  it('wraps trimmed profile facts', () => {
    const text = buildUserPersonaPrompt('  Name: Rohit\nPrefs: concise  ');
    expect(text).toContain('Name: Rohit\nPrefs: concise');
    expect(text).toContain('Treat as durable for this session');
    expect(text).not.toContain('No frozen user profile');
  });
});

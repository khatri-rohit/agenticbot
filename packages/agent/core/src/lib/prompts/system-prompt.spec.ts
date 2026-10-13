import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadAgentIdentity } from './load-agent-identity.js';
import { buildSystemPrompt, buildUserPersonaPrompt } from './system-prompt.js';
import { createToolRegistry } from '../tools/registry.js';

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

describe('agent.md identity', () => {
  it('stays in sync with agent.md', () => {
    const fromDisk = readFileSync(
      join(process.cwd(), 'src/lib/prompts/agent.md'),
      'utf8',
    ).trim();
    expect(loadAgentIdentity()).toBe(fromDisk);
  });

  it('is injected as the frozen identity tier', () => {
    const identity = loadAgentIdentity();
    expect(identity).toContain('# Identity');
    expect(identity).toContain('# Design language');
    expect(identity).toContain('# Language influence');
    expect(identity).toContain('# Anti-slop');

    const prompt = buildSystemPrompt(createToolRegistry([]), 'Prefs: BLUF');
    expect(prompt.startsWith(identity)).toBe(true);
    expect(prompt).toContain('# User Persona');
    expect(prompt).toContain('Prefs: BLUF');
    expect(prompt).toContain('# Tool calling protocol');
  });
});

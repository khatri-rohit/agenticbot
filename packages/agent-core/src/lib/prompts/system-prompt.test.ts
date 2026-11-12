import { describe, expect, it } from 'vitest';

import { WORKSPACE_MODE } from '@agent/agent-models';

import { createToolRegistry, listTools } from '../tools/registry';
import { buildSystemPrompt } from './system-prompt';

const registry = createToolRegistry(listTools(), WORKSPACE_MODE.globalTools, 'agent');

describe('workspace prompt and the harness card flag', () => {
  it('describes the card and the record on it when the card is on', () => {
    const prompt = buildSystemPrompt(registry, 'workspace', 'agent', { stateCard: true });
    expect(prompt).toContain('"[Harness card]" message');
    expect(prompt).toContain('The record stays on the harness card');
  });

  it('never mentions a card the model will not see when it is off (the A/B baseline)', () => {
    const prompt = buildSystemPrompt(registry, 'workspace', 'agent', { stateCard: false });
    expect(prompt).not.toMatch(/harness card/i);
    // Tool descriptions go to the model too, whatever the flag.
    for (const [name, tool] of registry.byName) {
      expect(JSON.stringify(tool.definition), name).not.toMatch(/harness card/i);
    }
    // record_finding is still offered, worded without the card.
    expect(prompt).toContain('write the answer from your recorded findings');
  });
});

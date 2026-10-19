import { describe, expect, it } from 'vitest';
import {
  applyPostureToTools,
  isAskStrippedTool,
  normalizeRunPosture,
} from '@org/agent-models';

import { ALL_TOOLS, createToolRegistry } from './registry';

describe('Ask posture tool pack', () => {
  it('normalizes only ask as ask', () => {
    expect(normalizeRunPosture('ask')).toBe('ask');
    expect(normalizeRunPosture('Ask')).toBe('ask');
    expect(normalizeRunPosture('agent')).toBe('agent');
    expect(normalizeRunPosture(undefined)).toBe('agent');
    expect(normalizeRunPosture('')).toBe('agent');
  });

  it('strips edit_file and run_terminal by name', () => {
    const names = [
      'glob',
      'grep',
      'read_file',
      'edit_file',
      'run_terminal',
      'load_skill',
      'memory',
      'plan',
      'todo',
    ];
    expect(applyPostureToTools(names, 'agent')).toEqual(names);
    expect(applyPostureToTools(names, 'ask')).toEqual([
      'glob',
      'grep',
      'read_file',
      'load_skill',
      'memory',
      'plan',
      'todo',
    ]);
  });

  it('drops write/exec tools from the registry even if still on the allow-list', () => {
    const agent = createToolRegistry(ALL_TOOLS, undefined, 'agent');
    const ask = createToolRegistry(
      ALL_TOOLS,
      ['glob', 'grep', 'read_file', 'edit_file', 'run_terminal', 'load_skill'],
      'ask',
    );
    expect(agent.byName.has('edit_file')).toBe(true);
    expect(agent.byName.has('run_terminal')).toBe(true);
    expect(ask.byName.has('edit_file')).toBe(false);
    expect(ask.byName.has('run_terminal')).toBe(false);
    expect(ask.byName.has('read_file')).toBe(true);
    expect(isAskStrippedTool('edit_file')).toBe(true);
    expect(isAskStrippedTool('read_file')).toBe(false);
  });
});

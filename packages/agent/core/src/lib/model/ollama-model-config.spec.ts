import { describe, expect, it } from 'vitest';
import type { OllamaModelConfig } from '@org/agent-models';
import { resolveReasoningEffort } from './ollama-model-config.js';

// resolveReasoningEffort is the only pure logic worth unit-testing here.
// getOllamaModelConfig is a thin fetch wrapper.

function cfg(thinking: OllamaModelConfig['thinking']): OllamaModelConfig {
  return {
    model: 'test',
    capabilities: [],
    contextLength: 8192,
    supportsTools: true,
    supportsVision: false,
    thinking,
  };
}

describe('resolveReasoningEffort', () => {
  it('omits when thinking is unsupported', () => {
    expect(
      resolveReasoningEffort(
        cfg({ supported: false, values: [], default: null, mode: 'none' }),
        'high',
      ),
    ).toBeUndefined();
  });

  it('maps boolean models to none / medium', () => {
    const boolean = cfg({
      supported: true,
      values: [false, true],
      default: false,
      mode: 'boolean',
    });
    expect(resolveReasoningEffort(boolean, false)).toBe('none');
    expect(resolveReasoningEffort(boolean, true)).toBe('medium');
  });

  it('clamps unknown levels to the model default', () => {
    const mixed = cfg({
      supported: true,
      values: [false, 'high', 'max'],
      default: 'high',
      mode: 'mixed',
    });
    expect(resolveReasoningEffort(mixed, false)).toBe('none');
    expect(resolveReasoningEffort(mixed, 'max')).toBe('max');
    expect(resolveReasoningEffort(mixed, 'low')).toBe('high');
  });
});

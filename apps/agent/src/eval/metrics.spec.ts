import { describe, expect, it } from 'vitest';

import {
  detectMetaToolLeak,
  scoreScenario,
  type EvalScenario,
} from './metrics';

describe('detectMetaToolLeak', () => {
  it('flags llama3.1 meta-only replies from logs', () => {
    expect(detectMetaToolLeak("I won't call any tool for this question.")).toBe(
      true,
    );
  });

  it('allows substantive answers that mention Paris', () => {
    expect(detectMetaToolLeak('The capital of France is Paris.')).toBe(false);
  });
});

describe('scoreScenario', () => {
  const stableFact: EvalScenario = {
    id: 'stable_fact',
    label: 'test',
    query: 'capital',
    policyGoal: 'test',
    toolCalls: { eq: 0 },
    answer: { mustMatch: [/paris/i] },
  };

  it('fails stable_fact when model only refuses tools', () => {
    const score = scoreScenario(
      {
        scenarioId: 'stable_fact',
        model: 'test',
        answer: "I won't call any tool for this question.",
        toolCalls: 0,
        iterations: 1,
        toolNames: [],
      },
      stableFact,
    );

    expect(score.pass).toBe(false);
    expect(score.metrics.find((m) => m.id === 'meta_tool_leak')?.pass).toBe(
      false,
    );
  });
});

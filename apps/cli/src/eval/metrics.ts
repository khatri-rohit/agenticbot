/**
 * Agent eval metrics — score runs against expectations before changing prompts or policies.
 *
 * Metric keys (use in reports and when editing system-prompt.ts):
 * - tool_calls: harness count (false positive / false negative vs scenario)
 * - iterations: cost / loop health
 * - meta_tool_leak: model narrates tool choice instead of answering
 * - substantive_answer: min length + required/forbidden content
 */

export const META_TOOL_LEAK_PATTERNS: RegExp[] = [
  /\bwon'?t call\b.*\btool/i,
  /\bwill not call (a )?tool\b/i,
  /\bno tool (is )?needed\b/i,
  /\bwithout (using )?(a )?tool\b/i,
  /\bI (?:will |won't )?(?:not )?use a tool\b/i,
  /\bdon'?t need to (?:use |call )/i,
  /\btool(?:s)? (?:is|are) not (?:required|necessary)\b/i,
];

export type ToolCallExpectation =
  { eq: number } | { min: number; max?: number };

export type AnswerExpectation = {
  minLength?: number;
  mustMatch?: RegExp[];
  mustNotMatch?: RegExp[];
};

export type EvalScenario = {
  id: string;
  label: string;
  query: string;
  /** What we optimize the system prompt and tool guardrails for */
  policyGoal: string;
  toolCalls: ToolCallExpectation;
  answer: AnswerExpectation;
  /** Skip when Firecrawl is down; still measures tool intent if run */
  requiresLiveSearch?: boolean;
};

export type ScenarioRunInput = {
  scenarioId: string;
  model: string;
  answer: string;
  toolCalls: number;
  iterations: number;
  toolNames: string[];
};

export type MetricResult = {
  id: string;
  pass: boolean;
  detail: string;
};

export type ScenarioScore = {
  scenarioId: string;
  pass: boolean;
  metrics: MetricResult[];
};

export function detectMetaToolLeak(answer: string): boolean {
  const trimmed = answer.trim();

  if (trimmed.length === 0) {
    return false;
  }

  const metaHits = META_TOOL_LEAK_PATTERNS.filter((pattern) =>
    pattern.test(trimmed),
  );

  if (metaHits.length === 0) {
    return false;
  }

  // Short replies that are only about tools count as leak.
  if (trimmed.length < 120) {
    return true;
  }

  // Long answer that mentions tools once may still be OK; flag only if very tool-heavy.
  const toolWords = trimmed.match(/\btool(?:s)?\b/gi)?.length ?? 0;

  return toolWords >= 2;
}

function scoreToolCalls(
  count: number,
  expected: ToolCallExpectation,
): MetricResult {
  if ('eq' in expected) {
    const pass = count === expected.eq;

    return {
      id: 'tool_calls',
      pass,
      detail: pass
        ? `tool_calls=${count} (expected ${expected.eq})`
        : `tool_calls=${count}, expected exactly ${expected.eq}`,
    };
  }

  const max = expected.max ?? Number.POSITIVE_INFINITY;
  const pass = count >= expected.min && count <= max;

  return {
    id: 'tool_calls',
    pass,
    detail: pass
      ? `tool_calls=${count} (expected ${expected.min}–${max === Number.POSITIVE_INFINITY ? '∞' : max})`
      : `tool_calls=${count}, expected ${expected.min}–${max === Number.POSITIVE_INFINITY ? '∞' : max}`,
  };
}

function scoreAnswer(
  answer: string,
  expected: AnswerExpectation,
): MetricResult[] {
  const results: MetricResult[] = [];
  const trimmed = answer.trim();

  if (expected.minLength !== undefined) {
    const pass = trimmed.length >= expected.minLength;

    results.push({
      id: 'answer_min_length',
      pass,
      detail: pass
        ? `length=${trimmed.length} (min ${expected.minLength})`
        : `length=${trimmed.length}, need >= ${expected.minLength}`,
    });
  }

  for (const pattern of expected.mustMatch ?? []) {
    const pass = pattern.test(trimmed);

    results.push({
      id: `answer_must_match:${pattern.source}`,
      pass,
      detail: pass
        ? `matched /${pattern.source}/`
        : `missing /${pattern.source}/`,
    });
  }

  for (const pattern of expected.mustNotMatch ?? []) {
    const pass = !pattern.test(trimmed);

    results.push({
      id: `answer_must_not:${pattern.source}`,
      pass,
      detail: pass
        ? `ok (not /${pattern.source}/)`
        : `forbidden match /${pattern.source}/`,
    });
  }

  const metaLeak = detectMetaToolLeak(trimmed);

  results.push({
    id: 'meta_tool_leak',
    pass: !metaLeak,
    detail: metaLeak
      ? 'answer discusses skipping tools instead of answering'
      : 'no meta tool narration',
  });

  return results;
}

export function scoreScenario(
  input: ScenarioRunInput,
  scenario: EvalScenario,
): ScenarioScore {
  const metrics: MetricResult[] = [
    scoreToolCalls(input.toolCalls, scenario.toolCalls),
    {
      id: 'iterations',
      pass: input.iterations <= 4,
      detail: `iterations=${input.iterations} (soft cap 4 for simple scenarios)`,
    },
    ...scoreAnswer(input.answer, scenario.answer),
  ];

  return {
    scenarioId: scenario.id,
    pass: metrics.every((metric) => metric.pass),
    metrics,
  };
}

export function formatReport(
  model: string,
  scores: ScenarioScore[],
  scenarios: EvalScenario[],
): string {
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const passed = scores.filter((score) => score.pass).length;
  const lines: string[] = [
    `Agent eval — model=${model}`,
    `Pass rate: ${passed}/${scores.length} (${scores.length ? Math.round((100 * passed) / scores.length) : 0}%)`,
    '',
    'id                          | tools | iter | meta | substance | PASS',
    '----------------------------|-------|------|------|-----------|-----',
  ];

  for (const score of scores) {
    const scenario = byId.get(score.scenarioId);
    const toolMetric = score.metrics.find((m) => m.id === 'tool_calls');
    const iterMetric = score.metrics.find((m) => m.id === 'iterations');
    const metaMetric = score.metrics.find((m) => m.id === 'meta_tool_leak');
    const substanceFail = score.metrics.some(
      (m) => m.id.startsWith('answer_') && m.id !== 'meta_tool_leak' && !m.pass,
    );

    lines.push(
      `${score.scenarioId.padEnd(27)} | ${toolMetric?.detail.split('=')[1]?.split(',')[0]?.padEnd(5) ?? '?'} | ${iterMetric?.detail.split('=')[1]?.split(' ')[0]?.padEnd(4) ?? '?'} | ${metaMetric?.pass ? 'ok  ' : 'LEAK'} | ${substanceFail ? 'fail' : 'ok  '} | ${score.pass ? 'PASS' : 'FAIL'}`,
    );

    if (!score.pass && scenario) {
      lines.push(`  goal: ${scenario.policyGoal}`);
      for (const metric of score.metrics.filter((m) => !m.pass)) {
        lines.push(`  - ${metric.id}: ${metric.detail}`);
      }
    }
  }

  lines.push('');
  lines.push(
    'Use failing metric ids to edit system-prompt.ts (meta_tool_leak, tool_calls) or tools.ts guardrails.',
  );

  return lines.join('\n');
}

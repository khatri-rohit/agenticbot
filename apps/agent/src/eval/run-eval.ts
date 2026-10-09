import {
  runLoop,
  invokeModelTurn,
  getContext,
  createToolRegistry,
  ALL_TOOLS,
  type TraceEvent,
} from '@org/agent-core';
import { formatReport, scoreScenario, type ScenarioRunInput } from './metrics';
import { EVAL_SCENARIOS } from './scenarios';

type RunStats = {
  toolCalls: number;
  iterations: number;
  toolNames: string[];
};

function createTraceCollector(stats: RunStats): (event: TraceEvent) => void {
  return (event) => {
    if (event.type === 'llm_request') {
      stats.iterations = event.iteration;
    }

    if (event.type === 'tool_start') {
      stats.toolCalls++;
      stats.toolNames.push(event.toolName);
    }
  };
}

async function runScenario(
  model: string,
  scenarioId: string,
  query: string,
): Promise<ScenarioRunInput & { answer: string }> {
  const tools = createToolRegistry(ALL_TOOLS);
  const messages = getContext(query, tools);
  const stats: RunStats = { toolCalls: 0, iterations: 0, toolNames: [] };

  const result = await runLoop(invokeModelTurn, messages, tools, {
    model,
    streaming: false,
    trace: createTraceCollector(stats),
    limits: {
      maxIterations: 8,
      maxToolCalls: 12,
      maxRepeatedToolCalls: 2,
      toolTimeoutMs: 30_000,
    },
  });

  return {
    scenarioId,
    model,
    answer: result.content,
    toolCalls: stats.toolCalls,
    iterations: stats.iterations || 1,
    toolNames: stats.toolNames,
  };
}

async function main() {
  const model =
    process.argv[2] ?? process.env.AGENT_EVAL_MODEL ?? 'llama3.1:8b';
  const skipSearch = process.env.AGENT_EVAL_SKIP_SEARCH === '1';

  const scenarios = EVAL_SCENARIOS.filter(
    (scenario) => !skipSearch || !scenario.requiresLiveSearch,
  );

  console.log(`Running ${scenarios.length} scenarios on ${model}...\n`);

  const scores = [];

  for (const scenario of scenarios) {
    process.stdout.write(`  ${scenario.id}... `);

    try {
      const run = await runScenario(model, scenario.id, scenario.query);
      const score = scoreScenario(run, scenario);

      scores.push(score);

      if (!score.pass) {
        console.log('FAIL');
        console.log(
          `    answer: ${run.answer.slice(0, 160).replace(/\s+/g, ' ')}`,
        );
      } else {
        console.log('PASS');
      }
    } catch (error) {
      console.log('ERROR');
      scores.push({
        scenarioId: scenario.id,
        pass: false,
        metrics: [
          {
            id: 'run_error',
            pass: false,
            detail: error instanceof Error ? error.message : String(error),
          },
        ],
      });
    }
  }

  console.log('\n' + formatReport(model, scores, scenarios));

  const failed = scores.filter((score) => !score.pass).length;

  process.exit(failed > 0 ? 1 : 0);
}

main();

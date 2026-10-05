import { META_TOOL_LEAK_PATTERNS, type EvalScenario } from './metrics';

const noMeta: RegExp[] = META_TOOL_LEAK_PATTERNS;

/** Fixed suite — extend when adding tools; re-run baseline before prompt changes. */
export const EVAL_SCENARIOS: EvalScenario[] = [
  {
    id: 'greeting',
    label: 'Greeting',
    query: 'Hi, how are you?',
    policyGoal:
      'No web_search; friendly reply (system prompt + web_search whenNotToUse).',
    toolCalls: { eq: 0 },
    answer: {
      minLength: 12,
      mustNotMatch: noMeta,
    },
  },
  {
    id: 'stable_fact',
    label: 'Stable general knowledge',
    query: 'What is the capital of France?',
    policyGoal:
      'No web_search; answer Paris from knowledge (stable_fact guardrail).',
    toolCalls: { eq: 0 },
    answer: {
      mustMatch: [/paris/i],
      mustNotMatch: noMeta,
    },
  },
  {
    id: 'recency',
    label: 'Time-sensitive topic',
    query: 'What is the latest news about OpenAI?',
    policyGoal:
      'Should invoke web_search at least once (whenToUse: current events).',
    toolCalls: { min: 1 },
    answer: {
      minLength: 40,
      mustNotMatch: noMeta,
    },
    requiresLiveSearch: true,
  },
  {
    id: 'explicit_search',
    label: 'User asks to search',
    query: 'Search the web and tell me what the latest React release is.',
    policyGoal: 'Must call web_search when user explicitly asks to search.',
    toolCalls: { min: 1 },
    answer: {
      minLength: 20,
      mustNotMatch: noMeta,
    },
    requiresLiveSearch: true,
  },
];

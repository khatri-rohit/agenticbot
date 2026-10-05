// tools for the agent
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { firecrawlSearch } from './libs/web';

export type ToolGuidance = {
  whenToUse: string[];
  whenNotToUse: string[];
  usage: string[];
};

export type Tool = {
  definition: ChatCompletionTool;
  guidance: ToolGuidance;
  execute: (args: Record<string, unknown>) => Promise<string>;
};

export type ToolRegistry = {
  definitions: ChatCompletionTool[];
  byName: Map<string, Tool>;
};

export const createTools = (): ToolRegistry => {
  const tools: Tool[] = [
    {
      definition: {
        type: 'function',
        function: {
          name: 'web_search',
          description:
            'Search the web for current, recent, time-sensitive, or web-specific information.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: 'The search query to be used to search the web',
              },
            },
            required: ['query'],
            additionalProperties: false,
          },
        },
      },
      guidance: {
        whenToUse: [
          'The user asks about current events, recent releases, prices, or anything time-sensitive.',
          'The user explicitly asks you to search the web or look something up online.',
          'You need external facts that may have changed after your knowledge cutoff.',
        ],
        whenNotToUse: [
          'Greetings, small talk, or casual conversation.',
          'Stable general knowledge (capitals, definitions, well-known history).',
          'Pure reasoning, math, or coding help that does not require live data.',
        ],
        usage: [
          'Write a specific query; include the current year when freshness matters.',
          'Prefer one focused search per sub-question before broadening.',
          'After results return, stop searching once you can answer; do not run near-duplicate queries.',
        ],
      },
      execute: async (args) => {
        const query = String(args.query ?? '');
        const response = await firecrawlSearch(query);
        return typeof response === 'string'
          ? response
          : JSON.stringify(response);
      },
    },
  ];
  const toolName = (def: ChatCompletionTool) =>
    def.type === 'function' ? def.function.name : def.custom.name;

  return {
    definitions: tools.map((tool) => tool.definition),
    byName: new Map(tools.map((tool) => [toolName(tool.definition), tool])),
  };
};

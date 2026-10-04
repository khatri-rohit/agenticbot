// tools for the agent
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { firecrawlSearch } from './libs/web';

export type Tool = {
  definition: ChatCompletionTool;
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
            'Search the web for current, recent, time-sensitive, ' +
            'or web-specific information. ' +
            'Do not use this tool for greetings, casual conversation, ' +
            'basic reasoning, or stable general knowledge.',
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

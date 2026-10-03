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
            "Web search is the tool that you can use to search the web for information of something that you need to know about. Somethings that is relevant to the question that you are asking. Everything that you need to know about the question that you are asking, is can't be found on the web. So use this tool for only when you need to know something that is can only be found on the web. For example, if you are asking about the latest news on the stock market, you can use this tool to search the web for the latest news on the stock market. Not for like when questions is 'How are you'.",
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

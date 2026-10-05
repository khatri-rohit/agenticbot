import type { Tool } from './registry';
import { firecrawlSearch } from './firecrawl';

/**
 * web_search tool — searches the web via Firecrawl for current information.
 */
export const webSearchTool: Tool = {
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
    return firecrawlSearch(query);
  },
};

/**
 * All available tools in the core package.
 * Apps and modes select from this list.
 */
export const allTools: Tool[] = [webSearchTool];
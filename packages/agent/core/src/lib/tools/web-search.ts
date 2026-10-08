import type { Tool } from './type';
import { webSearch, webFetch } from './web_search_api';

/**
 * web_search tool — searches the web via Ollama for current information.
 * Returns tiered results: top results with full page content, remaining
 * results as snippets with links.
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
    return webSearch(query, 5);
  },
};

/**
 * web_fetch tool — fetches the full content of a single web page by URL.
 * Always available as a native global tool, not user-toggleable.
 */
export const webFetchTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch the full content of a web page by URL. Use when the user provides a URL and asks to read or summarize it, or when you need deeper content from a specific page found in search results.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description:
              'The full URL of the web page to fetch (including protocol)',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  },
  guidance: {
    whenToUse: [
      'The user provides a URL and asks to read, summarize, or extract information from it.',
      'You found a promising URL in web_search results and need the full page content.',
      'You need to verify a specific claim by reading the original source page.',
    ],
    whenNotToUse: [
      'General conversation or questions without a specific URL.',
      'You need to search for information (use web_search instead).',
      'You already have enough content from search snippets to answer.',
    ],
    usage: [
      'Pass the full URL including the protocol (https:// or http://).',
      'If the fetch fails, inform the user and try alternative sources if available.',
      'Do not fetch the same URL multiple times if it already returned content.',
    ],
  },
  execute: async (args) => {
    const url = String(args.url ?? '');
    return webFetch(url);
  },
};

/**
 * All available tools in the core package.
 * Apps and modes select from this list.
 */
export const allTools: Tool[] = [webSearchTool, webFetchTool];

import type { Tool } from './type';
import { webSearch, webFetch } from './web_search_api';

/**
 * Built-in web_search — host-native function tool (not MCP / not a plugin).
 * Provider chain (Ollama / Firecrawl / Tavily) is internal; the model only
 * sees one tool that returns Detailed Sources + Further Reading.
 */
export const webSearchTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Built-in live web search. Use whenever you lack reliable, up-to-date knowledge for the user question (news, releases, docs, prices, people, products, APIs, or anything that may have changed). Returns Detailed Sources with real page text for top hits plus Further Reading links — not vague summaries. Ground your answer in those sources and cite URLs.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description:
              'A specific search query (include product/version names and the current year when freshness matters). Prefer one clear query over a vague topic phrase.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  guidance: {
    whenToUse: [
      'You do not have confident, current knowledge to answer (docs, APIs, releases, news, prices, people, products).',
      'The user asks you to search, look up, find, verify, or check something online.',
      'Facts may have changed after your knowledge cutoff, or you would otherwise guess.',
    ],
    whenNotToUse: [
      'Greetings, small talk, or casual conversation.',
      'Stable general knowledge you already know confidently (basic definitions, well-known history, simple math).',
      'Pure reasoning, or coding that is fully answered by the open folder.',
      'The user already gave a URL to read — use web_fetch instead.',
    ],
    usage: [
      'Call web_search directly — do not load a skill first.',
      'Write a specific query; include the current year when freshness matters.',
      'Prefer one focused search per sub-question before broadening.',
      'After results return, synthesize Detailed Sources into a complete answer with inline URL citations.',
      'Only web_fetch a Further Reading URL if that page is required to finish the answer.',
      'After a non-empty result, answer or web_fetch — do not issue another web_search for the same question.',
    ],
  },
  risk: 'network',
  execute: async (args, ctx) => {
    const query = String(args.query ?? '');
    return webSearch(query, 5, ctx.signal);
  },
};

/**
 * Built-in web_fetch — host-native function tool for a known URL.
 * Always available as a global tool (not gated by the web-search toggle).
 */
export const webFetchTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Built-in page reader. Fetch the full text of a specific URL (user-pasted link or a Further Reading URL from web_search). Returns page content suitable for citing — use this when you already know the URL.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description:
              'The full URL of the web page to fetch (including https:// or http://)',
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
      'A Further Reading URL from web_search is required to complete the answer.',
      'You need to verify a specific claim by reading the original source page.',
    ],
    whenNotToUse: [
      'General conversation or questions without a specific URL.',
      'You need to discover URLs first — use web_search instead.',
      'Detailed Sources from web_search already contain enough page text to answer.',
    ],
    usage: [
      'Pass the full URL including the protocol (https:// or http://).',
      'Answer from the fetched content and cite the URL.',
      'If the fetch fails, say so and use other available sources — do not invent page content.',
      'Do not fetch the same URL multiple times if it already returned content.',
    ],
  },
  risk: 'network',
  execute: async (args, ctx) => {
    const url = String(args.url ?? '');
    return webFetch(url, ctx.signal);
  },
};

/**
 * All available tools in the core package.
 * Apps and modes select from this list.
 */
export const WEB_SEARCH_TOOLS: Tool[] = [webSearchTool, webFetchTool];

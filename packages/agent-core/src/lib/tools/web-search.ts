import type { Tool } from './type';
import { webSearch, webFetch } from './web_search_api';
import { WEB_SLICE_DEFAULT_CHARS } from './web-source';

/**
 * Built-in web_search — host-native function tool (not MCP / not a plugin).
 * Provider chain is internal; the model sees hit cards (+ sha when prefetched).
 */
export const webSearchTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Built-in live web search. Returns hit cards (title, URL, snippet). Top hits are prefetched into a source store with sha256 — use web_fetch with sha256+offset+limit to read more of a page. If the user pasted a URL, prefer web_fetch. Cite URLs. Do not search the same question twice.',
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
      'After results return, answer from snippets or web_fetch sha256+offset for deeper sections.',
      'Only web_fetch URLs listed in the hit cards or pasted by the user.',
      'After a non-empty result, answer — do not issue another web_search for the same question.',
    ],
  },
  risk: 'network',
  execute: async (args, ctx) => {
    const query = String(args.query ?? '');
    return webSearch(query, 5, ctx);
  },
};

/**
 * Built-in web_fetch — URL fetch (source card) or sha256 slice read.
 * Always available as a global tool (not gated by the web-search toggle).
 */
export const webFetchTool: Tool = {
  definition: {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Read a known URL into the source store and return a short card (title, sha256, headings, first ~2k chars), or page a stored source with sha256+offset+limit. Full page text stays in the store — do not refetch the same URL for more text; use sha256 paging instead.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description:
              'https URL to fetch (user-pasted or a search hit). Omit when paging with sha256.',
          },
          sha256: {
            type: 'string',
            description:
              'sha256 from a prior web_fetch/web_search card. Use with offset/limit to read more of that source.',
          },
          offset: {
            type: 'number',
            description: 'Char offset into the stored source (default 0).',
          },
          limit: {
            type: 'number',
            description: `Max chars to return (default ${WEB_SLICE_DEFAULT_CHARS}, max 8000).`,
          },
        },
        additionalProperties: false,
      },
    },
  },
  guidance: {
    whenToUse: [
      'The user provides a URL and asks to read, summarize, or extract information from it.',
      'A search hit card has a sha256 and you need a later section of that page.',
      'You need to verify a specific claim by reading the original source page.',
    ],
    whenNotToUse: [
      'General conversation or questions without a specific URL or sha256.',
      'You need to discover URLs first — use web_search instead.',
      'The card/snippet already contains enough text to answer.',
    ],
    usage: [
      'Pass url to load a page (card + store). Pass sha256+offset+limit to continue reading.',
      'Answer from returned slices and cite the URL.',
      'If the fetch fails, say so — do not invent page content.',
      'Do not refetch the same URL, add hash variants, or use reader proxies for more text.',
    ],
  },
  risk: 'network',
  execute: async (args, ctx) => {
    return webFetch(
      {
        url: typeof args.url === 'string' ? args.url : undefined,
        sha256: typeof args.sha256 === 'string' ? args.sha256 : undefined,
        offset:
          typeof args.offset === 'number'
            ? args.offset
            : typeof args.offset === 'string'
              ? Number(args.offset)
              : undefined,
        limit:
          typeof args.limit === 'number'
            ? args.limit
            : typeof args.limit === 'string'
              ? Number(args.limit)
              : undefined,
      },
      ctx,
    );
  },
};

export const WEB_SEARCH_TOOLS: Tool[] = [webSearchTool, webFetchTool];

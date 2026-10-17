import type {
  WebFetchResponse,
  WebSearchResponse,
  WebSearchResult,
} from './type';
import {
  firecrawlFetch,
  firecrawlSearch,
  isRetryableError,
  ollamaFetch,
  ollamaSearch,
  tavilyFetch,
  tavilySearch,
} from './web-search-providers';

/** Number of top search results to auto-fetch full page content for. */
const AUTO_FETCH_DEPTH = 2;
/** Max chars of fetched page content to include in tool output. */
const MAX_PAGE_CONTENT_CHARS = 4_000;
/**
 * Hits whose content is already this long (scraped markdown / rich chunks)
 * skip a second web_fetch — Cursor-style one-shot depth.
 */
const MIN_DETAILED_CONTENT_CHARS = 800;

function truncateContent(content: string): string {
  if (content.length <= MAX_PAGE_CONTENT_CHARS) return content;
  return `${content.slice(0, MAX_PAGE_CONTENT_CHARS)}\n…[truncated]`;
}

function snippetPreview(content: string): string {
  if (content.length <= 280) return content;
  return `${content.slice(0, 280)}…`;
}

function hasDetailedContent(result: WebSearchResult): boolean {
  return result.content.trim().length >= MIN_DETAILED_CONTENT_CHARS;
}

/**
 * Search via the configured provider chain.
 * Ollama when keyed; otherwise Firecrawl keyless, then Tavily keyless on retryable failure.
 */
export async function webSearchApi(
  query: string,
  maxResults = 5,
  signal?: AbortSignal,
): Promise<WebSearchResponse> {
  if (process.env.OLLAMA_API_KEY) {
    return ollamaSearch(query, maxResults, signal);
  }

  try {
    return await firecrawlSearch(query, maxResults, signal);
  } catch (error) {
    if (!isRetryableError(error)) throw error;
  }

  return tavilySearch(query, maxResults, signal);
}

/**
 * Fetch a single URL via the configured provider chain.
 */
export async function webFetchApi(
  url: string,
  signal?: AbortSignal,
): Promise<WebFetchResponse> {
  if (process.env.OLLAMA_API_KEY) {
    return ollamaFetch(url, signal);
  }

  try {
    return await firecrawlFetch(url, signal);
  } catch (error) {
    if (!isRetryableError(error)) throw error;
  }

  return tavilyFetch(url, signal);
}

/**
 * Tiered web search: one provider search, then auto-fetch only when hits are
 * short snippets. Returns "Detailed Sources" + "Further Reading".
 *
 * Provider failover stays inside webSearchApi — the model gets one tool result.
 */
export async function webSearch(
  query: string,
  maxResults = 5,
  signal?: AbortSignal,
): Promise<string> {
  const searchResponse = await webSearchApi(query, maxResults, signal);
  const results = searchResponse.results;

  if (results.length === 0) {
    return `## Web Search Results: "${query}"\n\nNo results found.`;
  }

  const detailedResults = await Promise.all(
    results.slice(0, AUTO_FETCH_DEPTH).map(async (result) => {
      if (!result.url) {
        return { ...result, pageContent: null, links: [] as string[] };
      }

      // Already scraped / chunk-rich — skip a second HTTP fetch.
      if (hasDetailedContent(result)) {
        return {
          ...result,
          pageContent: truncateContent(result.content),
          links: [] as string[],
        };
      }

      try {
        const fetched = await webFetchApi(result.url, signal);
        return {
          ...result,
          pageContent: truncateContent(fetched.content),
          links: fetched.links,
        };
      } catch {
        // Fetch failed — degrade gracefully with snippet only.
        return { ...result, pageContent: null, links: [] as string[] };
      }
    }),
  );

  const lines: string[] = [`## Web Search Results: "${query}"`, ''];

  const detailed = detailedResults.filter((r) => r.pageContent);
  if (detailed.length > 0) {
    lines.push('### Detailed Sources');
    lines.push('');
    for (const r of detailed) {
      lines.push(`**${r.title}**`);
      lines.push(`URL: ${r.url}`);
      lines.push(`Snippet: ${snippetPreview(r.content)}`);
      lines.push('');
      lines.push(r.pageContent ?? '');
      if (r.links.length > 0) {
        lines.push('');
        lines.push(`Related links: ${r.links.slice(0, 5).join(', ')}`);
      }
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  // Snippet-only top hits (fetch skipped/failed) plus remaining search hits.
  const furtherReading = [
    ...detailedResults.filter((r) => !r.pageContent),
    ...results.slice(AUTO_FETCH_DEPTH),
  ];
  if (furtherReading.length > 0) {
    if (detailed.length > 0) lines.push('');
    lines.push('### Further Reading');
    lines.push('');
    for (const r of furtherReading) {
      lines.push(`**${r.title}** — ${snippetPreview(r.content)} — ${r.url}`);
    }
    lines.push('');
    lines.push('Use web_fetch on any URL above for deeper content if needed.');
  }

  return lines.join('\n');
}

/**
 * Fetch a single URL and format as structured context.
 * Used by the web_fetch tool.
 */
export async function webFetch(
  url: string,
  signal?: AbortSignal,
): Promise<string> {
  const fetched = await webFetchApi(url, signal);
  const truncated = truncateContent(fetched.content);

  const lines: string[] = [
    `## Web Fetch: ${url}`,
    '',
    `**${fetched.title}**`,
    '',
    truncated,
  ];

  if (fetched.links.length > 0) {
    lines.push('');
    lines.push('### Links on this page');
    lines.push(fetched.links.slice(0, 10).join('\n'));
  }

  return lines.join('\n');
}

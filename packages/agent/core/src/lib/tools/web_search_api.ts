import type { WebFetchResponse, WebSearchResponse } from './type';

/** Number of top search results to auto-fetch full page content for. */
const AUTO_FETCH_DEPTH = 2;
/** Max chars of fetched page content to include in tool output. */
const MAX_PAGE_CONTENT_CHARS = 4_000;

function getOllamaHeaders(): Record<string, string> {
  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey) {
    throw new Error('OLLAMA_API_KEY is not set');
  }
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Search the web via Ollama. Returns search result snippets
 * (title, url, content).
 */
export async function webSearchApi(
  query: string,
  maxResults = 5,
): Promise<WebSearchResponse> {
  const response = await fetch('https://ollama.com/api/web_search', {
    method: 'POST',
    headers: getOllamaHeaders(),
    body: JSON.stringify({ query, max_results: maxResults }),
  });
  if (!response.ok) {
    throw new Error(`web_search API returned ${response.status}`);
  }
  return (await response.json()) as WebSearchResponse;
}

/**
 * Fetch a single web page via Ollama. Returns title, content, and links.
 */
export async function webFetchApi(url: string): Promise<WebFetchResponse> {
  const response = await fetch('https://ollama.com/api/web_fetch', {
    method: 'POST',
    headers: getOllamaHeaders(),
    body: JSON.stringify({ url }),
  });
  if (!response.ok) {
    throw new Error(`web_fetch API returned ${response.status}`);
  }
  return (await response.json()) as WebFetchResponse;
}

/**
 * Tiered web search: searches via Ollama, then auto-fetches full page
 * content for the top results. Returns a structured context string
 * with "Detailed Sources" (fetched pages) and "Further Reading" (snippets).
 *
 * The model gets depth (full pages for top results) + breadth (snippets
 * for remaining results) + agency (can web_fetch any Further Reading URL).
 */
export async function webSearch(
  query: string,
  maxResults = 5,
): Promise<string> {
  const searchResponse = await webSearchApi(query, maxResults);
  const results = searchResponse.results;

  if (results.length === 0) {
    return `## Web Search Results: "${query}"\n\nNo results found.`;
  }

  // Auto-fetch top N results for deeper content.
  const detailedResults = await Promise.all(
    results.slice(0, AUTO_FETCH_DEPTH).map(async (result) => {
      if (!result.url) {
        return { ...result, pageContent: null, links: [] as string[] };
      }
      try {
        const fetched = await webFetchApi(result.url);
        const truncated =
          fetched.content.length > MAX_PAGE_CONTENT_CHARS
            ? `${fetched.content.slice(0, MAX_PAGE_CONTENT_CHARS)}\n…[truncated]`
            : fetched.content;
        return {
          ...result,
          pageContent: truncated,
          links: fetched.links,
        };
      } catch {
        // Fetch failed — degrade gracefully with snippet only.
        return { ...result, pageContent: null, links: [] as string[] };
      }
    }),
  );

  // Build formatted output.
  const lines: string[] = [`## Web Search Results: "${query}"`, ''];

  // Detailed Sources — full page content.
  const detailed = detailedResults.filter((r) => r.pageContent);
  if (detailed.length > 0) {
    lines.push('### Detailed Sources');
    lines.push('');
    for (const r of detailed) {
      lines.push(`**${r.title}**`);
      lines.push(`URL: ${r.url}`);
      lines.push(`Snippet: ${r.content}`);
      lines.push('');
      lines.push(r.pageContent!);
      if (r.links.length > 0) {
        lines.push('');
        lines.push(`Related links: ${r.links.slice(0, 5).join(', ')}`);
      }
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  // Further Reading — snippets + links for results we didn't fetch.
  const furtherReading = results.slice(detailedResults.length);
  if (furtherReading.length > 0) {
    if (detailed.length > 0) lines.push('');
    lines.push('### Further Reading');
    lines.push('');
    for (const r of furtherReading) {
      lines.push(`**${r.title}** — ${r.content} — ${r.url}`);
    }
    lines.push('');
    lines.push('Use web_fetch on any URL above for deeper content if needed.');
  }

  return lines.join('\n');
}

/**
 * Fetch a single URL via Ollama and format as structured context.
 * Used by the web_fetch tool.
 */
export async function webFetch(url: string): Promise<string> {
  const fetched = await webFetchApi(url);
  const truncated =
    fetched.content.length > MAX_PAGE_CONTENT_CHARS
      ? `${fetched.content.slice(0, MAX_PAGE_CONTENT_CHARS)}\n…[truncated]`
      : fetched.content;

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

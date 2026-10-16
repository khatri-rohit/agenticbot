import type { WebFetchResponse, WebSearchResponse } from './type';

/** Thrown when a provider response is empty or retryable (429 / 5xx / network). */
export class RetryableSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableSearchError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof RetryableSearchError) return true;
  if (error instanceof TypeError) return true; // fetch network failures
  return false;
}

async function parseJson(response: Response): Promise<unknown> {
  return (await response.json()) as unknown;
}

function throwForHttpStatus(provider: string, status: number): never {
  if (status === 429 || status >= 500) {
    throw new RetryableSearchError(`${provider} returned ${status}`);
  }
  throw new Error(`${provider} returned ${status}`);
}

// --- Ollama -----------------------------------------------------------------

export async function ollamaSearch(
  query: string,
  maxResults: number,
): Promise<WebSearchResponse> {
  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey) {
    throw new Error('OLLAMA_API_KEY is not set');
  }

  const response = await fetch('https://ollama.com/api/web_search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, max_results: maxResults }),
  });
  if (!response.ok) {
    throwForHttpStatus('ollama web_search', response.status);
  }

  const body = await parseJson(response);
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new RetryableSearchError('ollama web_search returned empty results');
  }

  const results = body.results
    .filter(isRecord)
    .map((item) => ({
      title: String(item.title ?? ''),
      url: String(item.url ?? ''),
      content: String(item.content ?? ''),
    }))
    .filter((item) => item.url.length > 0);

  if (results.length === 0) {
    throw new RetryableSearchError('ollama web_search returned empty results');
  }

  return { results: results.slice(0, maxResults) };
}

export async function ollamaFetch(url: string): Promise<WebFetchResponse> {
  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey) {
    throw new Error('OLLAMA_API_KEY is not set');
  }

  const response = await fetch('https://ollama.com/api/web_fetch', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) {
    throwForHttpStatus('ollama web_fetch', response.status);
  }

  const body = await parseJson(response);
  if (!isRecord(body)) {
    throw new Error('ollama web_fetch returned invalid JSON');
  }

  const links = Array.isArray(body.links)
    ? body.links.filter((link): link is string => typeof link === 'string')
    : [];

  return {
    title: String(body.title ?? ''),
    url: typeof body.url === 'string' ? body.url : url,
    content: String(body.content ?? ''),
    links,
  };
}

// --- Firecrawl --------------------------------------------------------------

function firecrawlHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

export async function firecrawlSearch(
  query: string,
  maxResults: number,
): Promise<WebSearchResponse> {
  const response = await fetch('https://api.firecrawl.dev/v2/search', {
    method: 'POST',
    headers: firecrawlHeaders(),
    body: JSON.stringify({
      query,
      limit: maxResults,
      scrapeOptions: { formats: ['markdown', 'links'] },
    }),
  });
  if (!response.ok) {
    throwForHttpStatus('firecrawl search', response.status);
  }

  const body = await parseJson(response);
  if (!isRecord(body)) {
    throw new RetryableSearchError('firecrawl search returned invalid JSON');
  }

  const data = isRecord(body.data) ? body.data : undefined;
  const web = Array.isArray(data?.web)
    ? data?.web
    : Array.isArray(body.data)
      ? body.data
      : [];

  if (!web) {
    throw new RetryableSearchError('firecrawl search returned empty results');
  }

  const results = web
    .filter(isRecord)
    .map((item) => {
      const title = String(item.title ?? '');
      const url = String(item.url ?? '');
      const markdown =
        typeof item.markdown === 'string' ? item.markdown.trim() : '';
      const description = String(item.description ?? item.content ?? '');
      // Prefer scraped markdown so the formatter can skip a second fetch.
      const content = markdown.length > 0 ? markdown : description;
      return { title, url, content };
    })
    .filter((item) => item.url.length > 0);

  if (results.length === 0) {
    throw new RetryableSearchError('firecrawl search returned empty results');
  }

  return { results: results.slice(0, maxResults) };
}

export async function firecrawlFetch(url: string): Promise<WebFetchResponse> {
  const response = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: firecrawlHeaders(),
    body: JSON.stringify({
      url,
      formats: ['markdown', 'links'],
    }),
  });
  if (!response.ok) {
    throwForHttpStatus('firecrawl scrape', response.status);
  }

  const body = await parseJson(response);
  if (!isRecord(body)) {
    throw new Error('firecrawl scrape returned invalid JSON');
  }

  const data = isRecord(body.data) ? body.data : body;
  const metadata = isRecord(data.metadata) ? data.metadata : undefined;
  const links = Array.isArray(data.links)
    ? data.links.filter((link): link is string => typeof link === 'string')
    : [];

  return {
    title: String(metadata?.title ?? data.title ?? ''),
    url: String(metadata?.sourceURL ?? data.url ?? url),
    content: String(data.markdown ?? data.content ?? ''),
    links,
  };
}

// --- Tavily -----------------------------------------------------------------

function tavilyHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const apiKey = process.env.TAVILY_API_KEY;
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  } else {
    headers['X-Tavily-Access-Mode'] = 'keyless';
  }
  return headers;
}

export async function tavilySearch(
  query: string,
  maxResults: number,
): Promise<WebSearchResponse> {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: tavilyHeaders(),
    body: JSON.stringify({
      query,
      max_results: maxResults,
      search_depth: 'basic',
    }),
  });
  if (!response.ok) {
    throwForHttpStatus('tavily search', response.status);
  }

  const body = await parseJson(response);
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new RetryableSearchError('tavily search returned empty results');
  }

  const results = body.results
    .filter(isRecord)
    .map((item) => ({
      title: String(item.title ?? ''),
      url: String(item.url ?? ''),
      content: String(item.content ?? ''),
    }))
    .filter((item) => item.url.length > 0);

  if (results.length === 0) {
    throw new RetryableSearchError('tavily search returned empty results');
  }

  return { results: results.slice(0, maxResults) };
}

export async function tavilyFetch(url: string): Promise<WebFetchResponse> {
  const response = await fetch('https://api.tavily.com/extract', {
    method: 'POST',
    headers: tavilyHeaders(),
    body: JSON.stringify({ urls: [url] }),
  });
  if (!response.ok) {
    throwForHttpStatus('tavily extract', response.status);
  }

  const body = await parseJson(response);
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new Error('tavily extract returned invalid JSON');
  }

  const first = body.results.find(isRecord);
  if (!first) {
    throw new Error('tavily extract returned no content for URL');
  }

  return {
    title: String(first.title ?? ''),
    url: String(first.url ?? url),
    content: String(first.raw_content ?? first.content ?? ''),
    links: [],
  };
}

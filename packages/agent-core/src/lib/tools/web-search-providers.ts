import type { WebFetchResponse, WebSearchResponse } from './type';
import { assertPublicHttpUrl } from './web-url';

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

function withSignal(
  init: RequestInit,
  signal?: AbortSignal,
): RequestInit {
  return signal ? { ...init, signal } : init;
}

// --- Ollama -----------------------------------------------------------------

export async function ollamaSearch(
  query: string,
  maxResults: number,
  signal?: AbortSignal,
): Promise<WebSearchResponse> {
  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey) {
    throw new RetryableSearchError('ollama web_search skipped: no API key');
  }

  const response = await fetch(
    'https://ollama.com/api/web_search',
    withSignal(
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, max_results: maxResults }),
      },
      signal,
    ),
  );
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

export async function ollamaFetch(
  url: string,
  signal?: AbortSignal,
): Promise<WebFetchResponse> {
  const apiKey = process.env.OLLAMA_API_KEY;
  if (!apiKey) {
    throw new RetryableSearchError('ollama web_fetch skipped: no API key');
  }

  const response = await fetch(
    'https://ollama.com/api/web_fetch',
    withSignal(
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url }),
      },
      signal,
    ),
  );
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
  signal?: AbortSignal,
): Promise<WebSearchResponse> {
  const response = await fetch(
    'https://api.firecrawl.dev/v2/search',
    withSignal(
      {
        method: 'POST',
        headers: firecrawlHeaders(),
        body: JSON.stringify({
          query,
          limit: maxResults,
          scrapeOptions: { formats: ['markdown', 'links'] },
        }),
      },
      signal,
    ),
  );
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

export async function firecrawlFetch(
  url: string,
  signal?: AbortSignal,
): Promise<WebFetchResponse> {
  const response = await fetch(
    'https://api.firecrawl.dev/v2/scrape',
    withSignal(
      {
        method: 'POST',
        headers: firecrawlHeaders(),
        body: JSON.stringify({
          url,
          formats: ['markdown', 'links'],
        }),
      },
      signal,
    ),
  );
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
  signal?: AbortSignal,
): Promise<WebSearchResponse> {
  const response = await fetch(
    'https://api.tavily.com/search',
    withSignal(
      {
        method: 'POST',
        headers: tavilyHeaders(),
        body: JSON.stringify({
          query,
          max_results: maxResults,
          search_depth: 'basic',
        }),
      },
      signal,
    ),
  );
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

export async function tavilyFetch(
  url: string,
  signal?: AbortSignal,
): Promise<WebFetchResponse> {
  const response = await fetch(
    'https://api.tavily.com/extract',
    withSignal(
      {
        method: 'POST',
        headers: tavilyHeaders(),
        body: JSON.stringify({ urls: [url] }),
      },
      signal,
    ),
  );
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

// --- Local HTTP (last fetch layer) ------------------------------------------

const HTTP_FETCH_MAX_BYTES = 1_000_000;

/**
 * Direct GET of a public URL. Last fetch fallback when scrape vendors fail
 * or return a thin body. No search index — fetch only.
 */
export async function httpFetch(
  url: string,
  signal?: AbortSignal,
): Promise<WebFetchResponse> {
  const headers = {
    Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1',
    'User-Agent': 'desk-web-fetch/1.0',
  };
  let target = assertPublicHttpUrl(url);
  let response: Response | undefined;
  for (let hop = 0; hop < 5; hop++) {
    response = await fetch(
      target.href,
      withSignal(
        {
          method: 'GET',
          headers,
          redirect: 'manual',
        },
        signal,
      ),
    );
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    if (!location) {
      throw new Error('http fetch redirect missing Location');
    }
    target = assertPublicHttpUrl(new URL(location, target.href).href);
  }
  if (!response) {
    throw new Error('http fetch failed');
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error('http fetch too many redirects');
  }
  if (!response.ok) {
    throwForHttpStatus('http fetch', response.status);
  }

  const mime = (response.headers.get('content-type') ?? '')
    .split(';', 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    mime &&
    !mime.startsWith('text/') &&
    mime !== 'application/xhtml+xml' &&
    mime !== 'application/xml' &&
    mime !== 'application/json'
  ) {
    throw new Error(`http fetch unsupported content type: ${mime}`);
  }

  const buffer = new Uint8Array(await response.arrayBuffer());
  const bytes = buffer.byteLength > HTTP_FETCH_MAX_BYTES
    ? buffer.slice(0, HTTP_FETCH_MAX_BYTES)
    : buffer;
  const html = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return extractReadablePage(target.href, html);
}

function extractReadablePage(url: string, html: string): WebFetchResponse {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = decodeEntities(
    (titleMatch?.[1] ?? '').replace(/\s+/g, ' ').trim(),
  );

  const links: string[] = [];
  const hrefPattern = /<a\b[^>]*href\s*=\s*["']([^"']+)["']/gi;
  let hrefMatch: RegExpExecArray | null;
  while ((hrefMatch = hrefPattern.exec(html)) !== null && links.length < 10) {
    try {
      const absolute = new URL(hrefMatch[1], url).href;
      if (
        (absolute.startsWith('http://') || absolute.startsWith('https://')) &&
        !links.includes(absolute)
      ) {
        links.push(absolute);
      }
    } catch {
      /* skip invalid href */
    }
  }

  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
  const content = decodeEntities(withoutNoise).replace(/\s+/g, ' ').trim();

  return { title, url, content, links };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

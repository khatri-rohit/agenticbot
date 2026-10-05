/* eslint-disable @typescript-eslint/no-explicit-any */
import { Firecrawl } from 'firecrawl';

/**
 * Single Firecrawl client. Lazily initialized from FIRECRAWL_API_KEY.
 * Merged from the two duplicate implementations that existed in apps/agent.
 */
let firecrawl: Firecrawl | null = null;

export function getFirecrawl(): Firecrawl {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new Error('FIRECRAWL_API_KEY is not set');
  }
  if (!firecrawl) {
    firecrawl = new Firecrawl({ apiKey });
  }
  return firecrawl;
}

/**
 * Search the web via Firecrawl. Returns compact JSON suitable for model context.
 */
export async function firecrawlSearch(query: string): Promise<string> {
  try {
    const fc = getFirecrawl();
    const results = await fc.search(query, {
      limit: 5,
      sources: ['web', 'news'],
      scrapeOptions: {
        formats: ['summary'],
        storeInCache: true,
        onlyMainContent: true,
      },
    });

    const webResults = ((results as any).web ?? []).map((r: any) => ({
      type: 'web',
      title: r.title ?? '',
      url: r.url ?? '',
      summary: r.summary ?? '',
    }));

    const newsResults = ((results as any).news ?? []).map((r: any) => ({
      type: 'news',
      title: r.title ?? '',
      url: r.url ?? '',
      summary: r.summary ?? '',
    }));

    return JSON.stringify({
      query,
      results: [...webResults, ...newsResults],
    });
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Scrape a batch of URLs. Returns compact JSON.
 */
export async function firecrawlGetPageContent(urls: string[]): Promise<string> {
  try {
    const fc = getFirecrawl();
    const results = await fc.batchScrape(urls, {
      options: { formats: ['summary'] },
      maxConcurrency: 1,
      timeout: 120,
    });
    return compactToolPayload(results);
  } catch (error) {
    return JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/* ---------- payload compaction (preserved from compact-tool-payload.ts) ---------- */

const MARKDOWN_PER_DOC = 5_000;
export const MAX_TOOL_PAYLOAD_CHARS = 80_000;

type ScrapedDoc = {
  url?: string;
  title?: string;
  markdown?: string;
  metadata?: { title?: string; description?: string };
};

function compactDoc(doc: ScrapedDoc) {
  const markdown = doc.markdown ?? '';
  const truncated = markdown.length > MARKDOWN_PER_DOC;
  return {
    url: doc.url,
    title: doc.metadata?.title ?? doc.title,
    description: doc.metadata?.description,
    markdown: truncated
      ? `${markdown.slice(0, MARKDOWN_PER_DOC)}\n…[truncated]`
      : markdown,
  };
}

function collectDocs(payload: unknown): ScrapedDoc[] {
  if (!payload || typeof payload !== 'object') return [];
  const root = payload as Record<string, unknown>;
  const docs: ScrapedDoc[] = [];

  if (Array.isArray(root.data)) {
    docs.push(...(root.data as ScrapedDoc[]));
  }
  for (const key of ['web', 'news']) {
    const chunk = root[key];
    if (Array.isArray(chunk)) docs.push(...(chunk as ScrapedDoc[]));
  }
  if (docs.length === 0 && root.data && typeof root.data === 'object') {
    for (const value of Object.values(root.data as Record<string, unknown>)) {
      if (Array.isArray(value)) docs.push(...(value as ScrapedDoc[]));
    }
  }
  return docs;
}

/**
 * Compact a tool payload to keep it small enough for Ollama context windows.
 * Truncates long markdown, caps total output size.
 */
export function compactToolPayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload.length > MAX_TOOL_PAYLOAD_CHARS
      ? `${payload.slice(0, MAX_TOOL_PAYLOAD_CHARS)}\n…[truncated]`
      : payload;
  }

  const docs = collectDocs(payload);
  if (docs.length === 0) {
    const raw = JSON.stringify(payload);
    return raw.length > MAX_TOOL_PAYLOAD_CHARS
      ? `${raw.slice(0, MAX_TOOL_PAYLOAD_CHARS)}\n…[truncated]`
      : raw;
  }

  const body = {
    results: docs.map(compactDoc),
    warning:
      typeof (payload as { warning?: unknown }).warning === 'string'
        ? (payload as { warning: string }).warning
        : undefined,
    error:
      typeof (payload as { error?: unknown }).error === 'string'
        ? (payload as { error: string }).error
        : undefined,
  };

  let text = JSON.stringify(body, null, 2);
  if (text.length > MAX_TOOL_PAYLOAD_CHARS) {
    const tighter = {
      ...body,
      results: body.results.map((r) => ({
        ...r,
        markdown: r.markdown.slice(0, 1_500),
      })),
    };
    text = JSON.stringify(tighter, null, 2);
  }
  if (text.length > MAX_TOOL_PAYLOAD_CHARS) {
    text = `${text.slice(0, MAX_TOOL_PAYLOAD_CHARS)}\n…[truncated]`;
  }
  return text;
}

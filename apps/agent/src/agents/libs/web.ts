/* eslint-disable @typescript-eslint/no-explicit-any */
import { Firecrawl } from 'firecrawl';

let firecrawl: Firecrawl | null = null;

export const getFirecrawl = async () => {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    throw new Error('FIRECRAWL_API_KEY is not set');
  }
  if (!firecrawl) {
    firecrawl = new Firecrawl({
      apiKey,
    });
  }
  return firecrawl;
};

export const firecrawlSearch = async (query: string) => {
  try {
    const firecrawl = await getFirecrawl();

    const results = await firecrawl.search(query, {
      limit: 5,
      sources: ['web', 'news'],
      scrapeOptions: {
        formats: ['summary'],
        storeInCache: true,
        onlyMainContent: true,
      },
    });

    const webResults = (results.web ?? []).map((result: any) => ({
      type: 'web',
      title: result.title ?? '',
      url: result.url ?? '',
      summary: result.summary ?? '',
    }));

    const newsResults = (results.news ?? []).map((result: any) => ({
      type: 'news',
      title: result.title ?? '',
      url: result.url ?? '',
      summary: result.summary ?? '',
    }));

    return JSON.stringify({
      query,
      results: [...webResults, ...newsResults],
    });
  } catch (error) {
    console.error('Error searching the web:', error);

    return JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export const firecrawlGetPageContent = async (urls: string[]) => {
  try {
    const firecrawl = await getFirecrawl();
    const results = await firecrawl.batchScrape(urls, {
      options: {
        formats: ['summary'],
      },
      maxConcurrency: 1,
      timeout: 120,
    });
    console.log('Results from firecrawl batchScrape: ', results);
    return results;
  } catch (error) {
    console.error('Error getting page content from firecrawl: ', error);
    return `Error getting page content from firecrawl: ${error}`;
  }
};

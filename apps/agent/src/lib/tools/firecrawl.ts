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
      limit: 10,
      sources: ['web', 'news'],
      scrapeOptions: {
        formats: ['markdown', 'html', 'json', 'summary'],
        storeInCache: true,
        onlyMainContent: true,
      },
      categories: ['research'],
    });
    console.log('Results from firecrawl search: ', results);
    return results;
  } catch (error) {
    console.error('Error searching the web: ', error);
    return `Error searching the web: ${error}`;
  }
};

export const firecrawlGetPageContent = async (urls: string[]) => {
  try {
    const firecrawl = await getFirecrawl();
    const results = await firecrawl.batchScrape(urls, {
      options: { formats: ['markdown', 'html', 'json', 'summary'] },
      maxConcurrency: 2,
      timeout: 120,
    });
    console.log('Results from firecrawl batchScrape: ', results);
    return results;
  } catch (error) {
    console.error('Error getting page content from firecrawl: ', error);
    return `Error getting page content from firecrawl: ${error}`;
  }
};

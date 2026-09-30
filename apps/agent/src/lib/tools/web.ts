import { tool } from '@langchain/core/tools';
import { firecrawlGetPageContent, firecrawlSearch } from './firecrawl';
import z from 'zod';

export const searchTool = tool(
  async ({ query }: { query: string }) => {
    const results = await firecrawlSearch(query);
    return results;
  },
  {
    name: 'web_search',
    description:
      'You must use this tool to search the web for information which u dont have and talk with real facts rather than hallucinating, only call this in case of user asked you to search the web for information or you need to get information from the web for the given query or you are given a list of urls and you need to get information from the web for the given urls or u think you need to search the web for information. But this dont mean you can search the web for information for every single time you are asked to do something, you should only use this tool when you are sure you need to search the web for information.',
    schema: z.object({
      query: z.string().describe('The query to search for'),
    }),
  },
);

export const getWebInformationTool = tool(
  async ({ urls }: { urls: string[] }) => {
    const results = await firecrawlGetPageContent(urls);
    return results;
  },
  {
    name: 'web_scrape',
    description:
      'You must use this tool to get information from multiple web pages for the given urls, only call this in case of user asked you to get information from the web for the given urls, dont call this tool if you dont have the urls or you dont know the urls',
    schema: z.object({
      urls: z.array(z.string()).describe('The URLs to get information from'),
    }),
  },
);

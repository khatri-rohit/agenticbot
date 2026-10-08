import { WebFetchResponse, WebSearchResponse, WebSearchResults } from './type';

/**
 * Search the web via Ollama. Returns compact JSON suitable for model context.
 */
export const webSearchApi = async (
  query: string,
  limit = 5,
): Promise<WebSearchResponse> => {
  const ollamaApiKey = process.env.OLLAMA_API_KEY;
  if (!ollamaApiKey) {
    throw new Error('OLLAMA_API_KEY is not set');
  }
  const response = await fetch('https://ollama.com/api/web_search', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ollamaApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      max_results: limit,
    }),
  });
  if (!response.ok) {
    throw new Error('Failed to search the web');
  }
  const data = (await response.json()) as WebSearchResponse;
  return data;
};

/**
 * Fetch the content of a web page via Ollama. Returns compact JSON suitable for model context.
 */
export const webFetchApi = async (url: string): Promise<WebFetchResponse> => {
  const ollamaApiKey = process.env.OLLAMA_API_KEY;
  if (!ollamaApiKey) {
    throw new Error('OLLAMA_API_KEY is not set');
  }
  const response = await fetch('https://ollama.com/api/web_fetch', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ollamaApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      url,
    }),
  });
  if (!response.ok) {
    throw new Error('Failed to fetch the web page');
  }
  const data = (await response.json()) as WebFetchResponse;
  return data;
};

/**
 * Web search tool: searches the web via Ollama for current information.
 * This tool is used to search the web and then fetch the content of the web pages.
 */
export const webSearch = async (
  query: string,
  limit = 5,
): Promise<WebSearchResults> => {
  const response: WebSearchResponse = await webSearchApi(query, limit);
  if (response.results.length === 0) {
    return {
      query,
      results: [],
    };
  }
  const results = response.results.map(async (result) => {
    if (!result.url) {
      return {
        title: result.title,
        url: result.url,
        content: '',
        links: [],
      };
    }
    const fetchResponse: WebFetchResponse = await webFetchApi(result.url);
    return {
      title: result.title,
      url: result.url,
      content: fetchResponse.content,
      links: fetchResponse.links,
    };
  });
  const content = await Promise.all(results);
  return {
    query,
    results: content as WebFetchResponse[],
  };
};

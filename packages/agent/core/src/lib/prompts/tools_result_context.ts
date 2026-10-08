export const webSearchResultContext = (
  query: string,
  results: string,
): string => {
  return `## Web Search Results of ${query}
  Here are the results of the web search. Use this information to answer the user's question.
  <results>
    ${results}
  </results>
  `;
};

const GOOGLE_SEARCH_MACRO = '@google_search';

export function getSearchFallbacks(macro, query) {
  if (macro !== GOOGLE_SEARCH_MACRO) return [];
  const encodedQuery = encodeURIComponent(query || '');
  return [
    {
      engine: 'duckduckgo',
      url: `https://duckduckgo.com/?q=${encodedQuery}`,
    },
    {
      engine: 'bing',
      url: `https://www.bing.com/search?q=${encodedQuery}`,
    },
  ];
}

const config = require('../config');

async function callSearxng(query, language = 'auto') {
  const url = new URL(config.SEARXNG_URL);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('language', language);

  const resp = await fetch(url, {
    headers: { 'X-API-Key': config.SEARXNG_API_KEY },
    signal: AbortSignal.timeout(config.SEARXNG_TIMEOUT),
  });

  if (!resp.ok) {
    throw new Error(`SearXNG error: ${resp.status}`);
  }

  return resp.json();
}

function formatSearchResults(searxngResponse, maxResults) {
  const max = maxResults || config.SEARCH_MAX_RESULTS || 8;
  const results = (searxngResponse.results || []).slice(0, max);

  if (results.length === 0) {
    return '未找到相关搜索结果。';
  }

  return results.map((r, i) => {
    const title = r.title || '无标题';
    const snippet = (r.content || '').slice(0, 300);
    const url = r.url || '';
    return `[${i + 1}] ${title}\n    ${snippet}\n    来源: ${url}`;
  }).join('\n\n');
}

function extractSources(searxngResponse, maxResults) {
  const max = maxResults || config.SEARCH_MAX_RESULTS || 8;
  const results = (searxngResponse.results || []).slice(0, max);
  return results
    .filter((r) => r.url && r.title)
    .map((r) => ({ url: r.url, title: r.title }));
}

module.exports = { callSearxng, formatSearchResults, extractSources };

/**
 * Firecrawl search adapter (v2 API) — default web search backend.
 * Docs: https://docs.firecrawl.dev
 */

import type { WebSearchAdapter, SearchResult, SearchOptions } from './types.js'

const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v2'

export class FirecrawlSearchAdapter implements WebSearchAdapter {
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const apiKey = process.env.FIRECRAWL_API_KEY ?? ''
    if (!apiKey) {
      return [{ title: '[Firecrawl not configured]', url: '', snippet: 'Set FIRECRAWL_API_KEY to enable web search' }]
    }

    options.onProgress?.({ type: 'query_update', query })

    try {
      const res = await fetch(`${FIRECRAWL_BASE}/search`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, limit: 8 }),
        signal: options.signal,
      })

      if (!res.ok) {
        return [{ title: `[Firecrawl error: ${res.status}]`, url: '', snippet: '' }]
      }

      const json = (await res.json()) as any
      const results: SearchResult[] = (json.data ?? []).map((r: any) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: (r.markdown ?? r.content ?? '').slice(0, 300),
      }))

      let filtered = results
      if (options.allowedDomains?.length) {
        filtered = filtered.filter(r =>
          options.allowedDomains!.some(d => r.url.includes(d)),
        )
      }
      if (options.blockedDomains?.length) {
        filtered = filtered.filter(r =>
          !options.blockedDomains!.some(d => r.url.includes(d)),
        )
      }

      options.onProgress?.({ type: 'search_results_received', resultCount: filtered.length })
      return filtered
    } catch (err) {
      return [{ title: '[Firecrawl search failed]', url: '', snippet: String(err) }]
    }
  }
}

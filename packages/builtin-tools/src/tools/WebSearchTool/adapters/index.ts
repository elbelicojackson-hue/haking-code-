/**
 * Search adapter factory — Firecrawl is the default backend.
 * Fallback order: firecrawl → api (Anthropic) → bing → brave
 */

import { isFirstPartyAnthropicBaseUrl } from 'src/utils/model/providers.js'
import { ApiSearchAdapter } from './apiAdapter.js'
import { BingSearchAdapter } from './bingAdapter.js'
import { BraveSearchAdapter } from './braveAdapter.js'
import { FirecrawlSearchAdapter } from './firecrawlAdapter.js'
import type { WebSearchAdapter } from './types.js'

export type {
  SearchResult,
  SearchOptions,
  SearchProgress,
  WebSearchAdapter,
} from './types.js'

let cachedAdapter: WebSearchAdapter | null = null
let cachedAdapterKey: 'firecrawl' | 'api' | 'bing' | 'brave' | null = null

export function createAdapter(): WebSearchAdapter {
  const envAdapter = process.env.WEB_SEARCH_ADAPTER
  const adapterKey =
    envAdapter === 'api' || envAdapter === 'bing' || envAdapter === 'brave' || envAdapter === 'firecrawl'
      ? envAdapter
      : process.env.FIRECRAWL_API_KEY
        ? 'firecrawl'
        : isFirstPartyAnthropicBaseUrl()
          ? 'api'
          : 'bing'

  if (cachedAdapter && cachedAdapterKey === adapterKey) return cachedAdapter

  if (adapterKey === 'firecrawl') {
    cachedAdapter = new FirecrawlSearchAdapter()
    cachedAdapterKey = 'firecrawl'
    return cachedAdapter
  }
  if (adapterKey === 'api') {
    cachedAdapter = new ApiSearchAdapter()
    cachedAdapterKey = 'api'
    return cachedAdapter
  }
  if (adapterKey === 'brave') {
    cachedAdapter = new BraveSearchAdapter()
    cachedAdapterKey = 'brave'
    return cachedAdapter
  }

  cachedAdapter = new BingSearchAdapter()
  cachedAdapterKey = 'bing'
  return cachedAdapter
}

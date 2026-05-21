/**
 * Firecrawl — web search + scrape (external truth anchor for Arena/Recon)
 */
const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v1'

function getApiKey(): string {
  return process.env.FIRECRAWL_API_KEY ?? ''
}

export async function firecrawlSearch(query: string, limit = 5): Promise<string[]> {
  const apiKey = getApiKey()
  if (!apiKey) return ['[Firecrawl not configured: set FIRECRAWL_API_KEY]']
  try {
    const res = await fetch(`${FIRECRAWL_BASE}/search`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit }),
    })
    if (!res.ok) return [`[Firecrawl error: ${res.status}]`]
    const json = await res.json() as any
    return (json.data ?? []).map((r: any) => `${r.title ?? ''}\n${r.url}\n${(r.markdown ?? r.content ?? '').slice(0, 300)}`)
  } catch (err) {
    return [`[Firecrawl: ${err instanceof Error ? err.message : String(err)}]`]
  }
}

export async function firecrawlScrape(url: string): Promise<string> {
  const apiKey = getApiKey()
  if (!apiKey) return '[Firecrawl not configured]'
  try {
    const res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, formats: ['markdown'] }),
    })
    if (!res.ok) return `[Firecrawl scrape error: ${res.status}]`
    const json = await res.json() as any
    return (json.data?.markdown ?? json.data?.content ?? '').slice(0, 2000)
  } catch (err) {
    return `[Firecrawl: ${err instanceof Error ? err.message : String(err)}]`
  }
}

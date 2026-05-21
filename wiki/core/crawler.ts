/**
 * Haking Wiki — crawler.
 *
 * Pipeline: URL → Firecrawl /scrape → markdown → write .md file → upsert
 * a 'page' node into the WikiGraph with summary + body pointer.
 *
 * Falls back to fetch + Turndown if FIRECRAWL_API_KEY is unset (lower
 * fidelity, no JS rendering, but works offline-from-credentials).
 */
import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import type { WikiGraph, WikiNode } from './graph.js'

const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v1'

function getFirecrawlKey(): string {
  return process.env.FIRECRAWL_API_KEY ?? ''
}

export type CrawlResult = {
  url: string
  title: string
  markdown: string
  /** Nodes-of-interest extracted by the crawler (currently: just the page itself). */
  node: WikiNode
}

/**
 * Strip noisy lines from markdown so summaries are usable.
 * Keeps headings + first paragraphs, drops nav-link soup.
 */
function makeSummary(markdown: string, max = 280): string {
  const cleaned = markdown
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0)
    .filter(l => !/^!\[/.test(l))           // images
    .filter(l => !/^\[.*\]\(.*\)$/.test(l)) // pure-link lines
    .join(' ')
  return cleaned.slice(0, max).replace(/\s+/g, ' ').trim()
}

function inferTitle(url: string, markdown: string): string {
  // Prefer the first H1 or H2 we find.
  const m = markdown.match(/^\s*#{1,2}\s+(.+)$/m)
  if (m) return m[1]!.trim()
  // Fall back to the URL pathname end.
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop()
    if (last) return decodeURIComponent(last)
    return u.hostname
  } catch {
    return url
  }
}

async function fetchViaFirecrawl(url: string): Promise<string> {
  const apiKey = getFirecrawlKey()
  if (!apiKey) throw new Error('FIRECRAWL_API_KEY not set')
  const res = await fetch(`${FIRECRAWL_BASE}/scrape`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url, formats: ['markdown'] }),
  })
  if (!res.ok) {
    throw new Error(`Firecrawl ${res.status}: ${await res.text()}`)
  }
  const json = (await res.json()) as any
  const md = json.data?.markdown ?? json.data?.content ?? ''
  if (!md) throw new Error('Firecrawl returned empty markdown')
  return md
}

async function fetchViaTurndown(url: string): Promise<string> {
  // Lazy import — only paid when the no-API-key path executes.
  const { default: TurndownService } = await import('turndown')
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (compatible; HakingWiki/1.0; +https://github.com/elbelicojackson-hue/haking-code-)',
    },
  })
  if (!res.ok) throw new Error(`fetch ${res.status} ${res.statusText}`)
  const html = await res.text()
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  return td.turndown(html)
}

export type CrawlerOptions = {
  /** wiki root directory (e.g. .haking/wiki/) — pages/ goes inside this. */
  wikiRoot: string
}

export class WikiCrawler {
  constructor(
    private graph: WikiGraph,
    private opts: CrawlerOptions,
  ) {}

  private pagePath(id: string): string {
    return join(this.opts.wikiRoot, 'pages', `${id}.md`)
  }

  /**
   * Crawl a URL and store as a 'page' node. Idempotent on (url) — re-crawling
   * the same URL updates the existing node and overwrites its body file.
   */
  async crawl(url: string, opts: { tags?: string[] } = {}): Promise<CrawlResult> {
    let markdown: string
    try {
      markdown = await fetchViaFirecrawl(url)
    } catch (firecrawlErr) {
      try {
        markdown = await fetchViaTurndown(url)
      } catch (fetchErr) {
        throw new Error(
          `crawl failed for ${url}: firecrawl=${(firecrawlErr as Error).message}; fetch=${(fetchErr as Error).message}`,
        )
      }
    }

    const title = inferTitle(url, markdown)
    const summary = makeSummary(markdown)

    // Node id derived from URL so re-crawls dedupe rather than duplicate.
    let id: string
    try {
      const u = new URL(url)
      id = `${u.hostname}${u.pathname}`.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '')
      if (!id) id = u.hostname
    } catch {
      id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    }
    if (id.length > 80) id = id.slice(0, 80)

    // Persist body to .md file
    const bodyPath = this.pagePath(id)
    mkdirSync(dirname(bodyPath), { recursive: true })
    writeFileSync(bodyPath, markdown)

    const node = await this.graph.upsertNode({
      id,
      kind: 'page',
      title,
      url,
      summary,
      tags: opts.tags,
      body: bodyPath,
    })

    return { url, title, markdown, node }
  }
}

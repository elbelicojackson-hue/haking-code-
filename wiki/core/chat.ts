/**
 * Haking Wiki — AI chat layer.
 *
 * Pipeline:
 *   1. User asks a question
 *   2. Search wiki graph for relevant nodes (substring match)
 *   3. If hits found → read their .md bodies → inject as context
 *   4. If NO hits → Firecrawl search → crawl top results → build nodes → use as context
 *   5. Call DeepSeek with system prompt + context + question
 *   6. Stream answer back token-by-token
 *
 * Uses raw fetch against DeepSeek's /anthropic endpoint (same as deepseek-direct.ts)
 * to avoid importing the full Haking Code machinery into the wiki subprocess.
 */
import { readFileSync, existsSync } from 'fs'
import type { WikiGraph, WikiNode } from './graph.js'
import type { WikiCrawler } from './crawler.js'

const FIRECRAWL_BASE = 'https://api.firecrawl.dev/v1'

export type ChatSource = {
  id: string
  title: string
  url?: string
}

export type ChatChunk =
  | { type: 'sources'; sources: ChatSource[] }
  | { type: 'text'; text: string }
  | { type: 'expanding'; query: string }
  | { type: 'expanded'; newNodes: ChatSource[] }
  | { type: 'done' }
  | { type: 'error'; error: string }

export type AskOptions = {
  graph: WikiGraph
  crawler: WikiCrawler
  question: string
  /** Max wiki nodes to inject as context */
  maxContext?: number
}

const SYSTEM_PROMPT = `You are Haking Wiki AI — a security research assistant with access to a local knowledge graph.
Answer the user's question based on the provided wiki context. Be concise and technical.
If the context contains relevant information, cite the source by title in brackets like [Source Title].
If the context is insufficient, say so honestly.
Always respond in the same language as the user's question.`

function getApiKey(): string {
  return process.env.ANTHROPIC_API_KEY || ''
}

function getBaseUrl(): string {
  return process.env.ANTHROPIC_BASE_URL || 'https://api.deepseek.com/anthropic'
}

function getModel(): string {
  return process.env.ANTHROPIC_SMALL_FAST_MODEL || process.env.ANTHROPIC_MODEL || 'deepseek-v4-flash'
}

function getFirecrawlKey(): string {
  return process.env.FIRECRAWL_API_KEY || ''
}

function readBody(node: WikiNode, wikiRoot: string): string {
  const path = node.body || `${wikiRoot}/pages/${node.id}.md`
  if (!existsSync(path)) return node.summary || ''
  try {
    const content = readFileSync(path, 'utf-8')
    // Truncate to ~4K chars per node to stay within context budget
    return content.slice(0, 4000)
  } catch {
    return node.summary || ''
  }
}

async function firecrawlSearch(query: string, limit = 3): Promise<Array<{ title: string; url: string }>> {
  const key = getFirecrawlKey()
  if (!key) return []
  try {
    const res = await fetch(`${FIRECRAWL_BASE}/search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit }),
    })
    if (!res.ok) return []
    const json = (await res.json()) as any
    return (json.data || [])
      .filter((r: any) => r.url)
      .map((r: any) => ({ title: r.title || r.url, url: r.url }))
  } catch {
    return []
  }
}

/**
 * Main ask pipeline. Yields ChatChunk events for streaming to the client.
 */
export async function* ask(opts: AskOptions): AsyncGenerator<ChatChunk, void> {
  const { graph, crawler, question } = opts
  const maxContext = opts.maxContext ?? 5
  const wikiRoot = process.env.WIKI_ROOT || '.haking/wiki'

  // Step 1: search local wiki
  let hits = graph.searchNodes(question, maxContext)
  let sources: ChatSource[] = hits.map(n => ({ id: n.id, title: n.title, url: n.url }))

  // Step 2: if no local hits, auto-expand via Firecrawl
  if (hits.length === 0) {
    yield { type: 'expanding', query: question }

    const searchResults = await firecrawlSearch(question, 3)
    if (searchResults.length > 0) {
      const newNodes: ChatSource[] = []
      for (const sr of searchResults) {
        try {
          const result = await crawler.crawl(sr.url)
          newNodes.push({ id: result.node.id, title: result.title, url: sr.url })
        } catch {
          // Skip failed crawls
        }
      }
      if (newNodes.length > 0) {
        yield { type: 'expanded', newNodes }
        // Re-search with the newly added nodes
        hits = graph.searchNodes(question, maxContext)
        sources = hits.map(n => ({ id: n.id, title: n.title, url: n.url }))
      }
    }
  }

  // Emit sources so UI can show references
  if (sources.length > 0) {
    yield { type: 'sources', sources }
  }

  // Step 3: build context from node bodies
  let context = ''
  for (const node of hits) {
    const body = readBody(node, wikiRoot)
    if (body) {
      context += `\n---\n### [${node.title}]${node.url ? ` (${node.url})` : ''}\n${body}\n`
    }
  }

  // Step 4: call DeepSeek
  const apiKey = getApiKey()
  if (!apiKey) {
    yield { type: 'error', error: 'ANTHROPIC_API_KEY not configured. Run /setup or set env.' }
    return
  }

  const messages = [
    {
      role: 'user' as const,
      content: context
        ? `Based on the following wiki knowledge:\n${context}\n\n---\nQuestion: ${question}`
        : question,
    },
  ]

  const body = {
    model: getModel(),
    max_tokens: 4096,
    stream: true,
    system: [{ type: 'text', text: SYSTEM_PROMPT }],
    messages,
  }

  try {
    const res = await fetch(`${getBaseUrl()}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
        accept: 'text/event-stream',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errText = await res.text()
      let msg = errText
      try {
        const j = JSON.parse(errText)
        msg = j.error?.message || j.message || errText
      } catch { /* keep raw */ }
      yield { type: 'error', error: `DeepSeek ${res.status}: ${msg}` }
      return
    }

    if (!res.body) {
      yield { type: 'error', error: 'No response body' }
      return
    }

    // Parse SSE stream
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)

        let dataLine: string | null = null
        for (const line of raw.split('\n')) {
          if (line.startsWith('data: ')) { dataLine = line.slice(6); break }
          if (line.startsWith('data:')) { dataLine = line.slice(5); break }
        }
        if (!dataLine || dataLine === '[DONE]') continue

        let evt: any
        try { evt = JSON.parse(dataLine) } catch { continue }

        if (evt.type === 'content_block_delta') {
          const d = evt.delta
          if (d?.type === 'text_delta' && d.text) {
            yield { type: 'text', text: d.text }
          }
        }
      }
    }
  } catch (err) {
    yield { type: 'error', error: err instanceof Error ? err.message : String(err) }
    return
  }

  yield { type: 'done' }
}

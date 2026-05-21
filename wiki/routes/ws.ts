/**
 * WebSocket protocol for the wiki UI.
 *
 * Wire format is JSON. Server pushes:
 *   { type: 'snapshot', snapshot }       — sent once on connect
 *   { type: 'delta', delta }             — every graph mutation (delta is a GraphDelta)
 *
 * Client may send:
 *   { type: 'crawl', url, tags? }        — request crawler to fetch a URL
 *   { type: 'search', q, limit? }        — fuzzy search; reply { type: 'search:result', q, hits }
 *   { type: 'ping' }                     — connection keepalive; reply { type: 'pong' }
 *
 * Reuse the WikiGraph subscribe() mechanism for delta fan-out.
 */
import type { ServerWebSocket } from 'bun'
import type { GraphDelta, WikiGraph } from '../core/graph.js'
import type { WikiCrawler } from '../core/crawler.js'

export type WsContext = {
  /** Set on each connected ws via ws.data.unsubscribe = ... */
  unsubscribe?: () => void
}

export function attachClient(
  ws: ServerWebSocket<WsContext>,
  graph: WikiGraph,
): void {
  // Send full snapshot first so the UI has something to render even if no
  // mutations follow.
  try {
    ws.send(JSON.stringify({ type: 'snapshot', snapshot: graph.snapshot() }))
  } catch {
    /* ignore send-on-open failures */
  }

  // Subscribe to deltas; tear down on close.
  const unsubscribe = graph.subscribe((delta: GraphDelta) => {
    try {
      ws.send(JSON.stringify({ type: 'delta', delta }))
    } catch {
      /* ignore — client probably disconnected, close handler will cleanup */
    }
  })
  ws.data.unsubscribe = unsubscribe
}

export function detachClient(ws: ServerWebSocket<WsContext>): void {
  try {
    ws.data?.unsubscribe?.()
  } catch {
    /* ignore */
  }
}

export async function handleClientMessage(
  ws: ServerWebSocket<WsContext>,
  raw: string | Buffer,
  graph: WikiGraph,
  crawler: WikiCrawler,
): Promise<void> {
  let msg: any
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString())
  } catch {
    ws.send(JSON.stringify({ type: 'error', error: 'invalid JSON' }))
    return
  }

  switch (msg?.type) {
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', t: Date.now() }))
      return

    case 'crawl': {
      const url = String(msg.url || '')
      if (!url) {
        ws.send(JSON.stringify({ type: 'error', error: 'crawl: url required' }))
        return
      }
      // Acknowledge so the UI can show a spinner.
      ws.send(JSON.stringify({ type: 'crawl:start', url }))
      try {
        const result = await crawler.crawl(url, { tags: msg.tags })
        // Crawler upserts the node, which triggers a delta broadcast to all
        // listeners (including this ws). Just send a completion ack here.
        ws.send(
          JSON.stringify({
            type: 'crawl:done',
            url,
            nodeId: result.node.id,
            title: result.title,
          }),
        )
      } catch (err) {
        ws.send(
          JSON.stringify({
            type: 'crawl:error',
            url,
            error: err instanceof Error ? err.message : String(err),
          }),
        )
      }
      return
    }

    case 'search': {
      const q = String(msg.q || '')
      const limit = Math.min(100, Number(msg.limit || 20) || 20)
      const hits = graph.searchNodes(q, limit)
      ws.send(JSON.stringify({ type: 'search:result', q, hits }))
      return
    }

    default:
      ws.send(
        JSON.stringify({ type: 'error', error: `unknown message type: ${msg?.type}` }),
      )
  }
}

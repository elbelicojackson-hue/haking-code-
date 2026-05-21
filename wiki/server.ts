/**
 * Haking Wiki — server.
 *
 * Single Bun.serve instance that handles:
 *   - Static files from wiki/web/  (index.html, graph.js, style.css, ...)
 *   - REST API under /api/*        (graph CRUD)
 *   - WebSocket on /ws             (live snapshot + delta stream + crawl/search RPC)
 *   - GET /pages/:id               (raw markdown body for the right-side panel)
 *
 * Defaults to port 7891 (7890 is owned by the Haking Island broadcaster).
 * Wiki data lives under {projectRoot}/.haking/wiki/ which is gitignored
 * via the existing .haking/ rule in the root .gitignore.
 */
import { existsSync, mkdirSync, readFileSync } from 'fs'
import { join, dirname, resolve } from 'path'
import type { ServerWebSocket } from 'bun'
import { WikiGraph } from './core/graph.js'
import { WikiCrawler } from './core/crawler.js'
import { handleApi } from './routes/api.js'
import { attachClient, detachClient, handleClientMessage, type WsContext } from './routes/ws.js'

// ---------- Config ----------

const PORT = Number(process.env.WIKI_PORT || 7891)
const WIKI_ROOT =
  process.env.WIKI_ROOT ||
  resolve(process.cwd(), '.haking', 'wiki')
const WEB_DIR = resolve(import.meta.dirname || dirname(Bun.fileURLToPath(import.meta.url)), 'web')

// ---------- Boot ----------

mkdirSync(WIKI_ROOT, { recursive: true })
mkdirSync(join(WIKI_ROOT, 'pages'), { recursive: true })

const graph = new WikiGraph(join(WIKI_ROOT, 'graph.json'))
const crawler = new WikiCrawler(graph, { wikiRoot: WIKI_ROOT })

// ---------- Static file mime helpers ----------

const MIME: { [ext: string]: string } = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

function mimeOf(path: string): string {
  const dot = path.lastIndexOf('.')
  return dot >= 0 ? MIME[path.slice(dot).toLowerCase()] || 'application/octet-stream' : 'application/octet-stream'
}

async function serveStatic(rootDir: string, requestPath: string): Promise<Response | null> {
  // Default to index.html for `/`.
  let rel = requestPath === '/' ? '/index.html' : requestPath
  // Block path traversal: forbid `..` and absolute paths in the request.
  if (rel.includes('..') || rel.startsWith('//')) return new Response('forbidden', { status: 403 })
  const full = join(rootDir, rel)
  if (!full.startsWith(rootDir)) return new Response('forbidden', { status: 403 })
  if (!existsSync(full)) return null
  const file = Bun.file(full)
  return new Response(file, { headers: { 'content-type': mimeOf(rel) } })
}

// ---------- Page body fetch (markdown) ----------

async function servePageBody(id: string): Promise<Response> {
  const node = graph.getNode(id)
  if (!node) return new Response('not found', { status: 404 })
  const path = node.body || join(WIKI_ROOT, 'pages', `${id}.md`)
  if (!existsSync(path)) {
    return new Response('# ' + (node.title || id) + '\n\n(no body)', {
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    })
  }
  return new Response(readFileSync(path, 'utf-8'), {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  })
}

// ---------- Server ----------

const server = Bun.serve<WsContext>({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req, srv) {
    const url = new URL(req.url)
    const pathname = url.pathname

    // WebSocket upgrade
    if (pathname === '/ws') {
      // Initialize ws.data with empty context — attachClient sets unsubscribe.
      if (srv.upgrade(req, { data: {} as WsContext })) {
        return undefined as unknown as Response // Bun handles the upgrade
      }
      return new Response('upgrade required', { status: 426 })
    }

    // REST API
    if (pathname.startsWith('/api/')) {
      try {
        return await handleApi(graph, req, pathname)
      } catch (err) {
        return new Response(
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          }),
          { status: 500, headers: { 'content-type': 'application/json' } },
        )
      }
    }

    // Page body
    if (pathname.startsWith('/pages/')) {
      const id = decodeURIComponent(pathname.slice('/pages/'.length))
      return await servePageBody(id)
    }

    // Static files from wiki/web/
    const staticResp = await serveStatic(WEB_DIR, pathname)
    if (staticResp) return staticResp

    return new Response('not found', { status: 404 })
  },
  websocket: {
    open(ws: ServerWebSocket<WsContext>) {
      attachClient(ws, graph)
    },
    async message(ws: ServerWebSocket<WsContext>, msg: string | Buffer) {
      await handleClientMessage(ws, msg, graph, crawler)
    },
    close(ws: ServerWebSocket<WsContext>) {
      detachClient(ws)
    },
    // No backpressure handling needed for our small JSON payloads; rely on
    // Bun's default 16MB sendQueue.
  },
})

console.log(`✦ Haking Wiki running at http://${server.hostname}:${server.port}/`)
console.log(`  WikiRoot: ${WIKI_ROOT}`)
console.log(`  WebDir:   ${WEB_DIR}`)
console.log(`  WS:       ws://${server.hostname}:${server.port}/ws`)

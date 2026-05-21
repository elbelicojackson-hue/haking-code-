/**
 * REST API handlers for the wiki graph.
 *
 * Each handler takes a parsed Request (or just the body) and returns a
 * Response. Pure functions of (graph, request) — server.ts owns routing
 * and CORS / error formatting.
 */
import type { WikiGraph } from '../core/graph.js'

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function badRequest(message: string): Response {
  return json({ error: message }, 400)
}

function notFound(message = 'not found'): Response {
  return json({ error: message }, 404)
}

export async function handleApi(
  graph: WikiGraph,
  req: Request,
  pathname: string,
): Promise<Response> {
  // GET /api/graph — full snapshot for initial UI hydration
  if (req.method === 'GET' && pathname === '/api/graph') {
    return json(graph.snapshot())
  }

  // GET /api/nodes
  if (req.method === 'GET' && pathname === '/api/nodes') {
    return json(graph.listNodes())
  }

  // GET /api/edges
  if (req.method === 'GET' && pathname === '/api/edges') {
    return json(graph.listEdges())
  }

  // GET /api/search?q=...
  if (req.method === 'GET' && pathname === '/api/search') {
    const url = new URL(req.url)
    const q = url.searchParams.get('q') || ''
    const limit = Math.min(100, Number(url.searchParams.get('limit') || '20') || 20)
    return json(graph.searchNodes(q, limit))
  }

  // GET /api/nodes/:id
  if (req.method === 'GET' && pathname.startsWith('/api/nodes/')) {
    const id = decodeURIComponent(pathname.slice('/api/nodes/'.length))
    const node = graph.getNode(id)
    if (!node) return notFound(`node '${id}'`)
    return json(node)
  }

  // POST /api/nodes  { title, kind, ... }
  if (req.method === 'POST' && pathname === '/api/nodes') {
    let body: any
    try {
      body = await req.json()
    } catch {
      return badRequest('body must be JSON')
    }
    if (!body?.title || !body?.kind) {
      return badRequest('title and kind are required')
    }
    const node = await graph.upsertNode(body)
    return json(node, 201)
  }

  // PUT /api/nodes/:id — partial update
  if (req.method === 'PUT' && pathname.startsWith('/api/nodes/')) {
    const id = decodeURIComponent(pathname.slice('/api/nodes/'.length))
    if (!graph.getNode(id)) return notFound(`node '${id}'`)
    let body: any
    try {
      body = await req.json()
    } catch {
      return badRequest('body must be JSON')
    }
    const node = await graph.upsertNode({ ...body, id })
    return json(node)
  }

  // DELETE /api/nodes/:id
  if (req.method === 'DELETE' && pathname.startsWith('/api/nodes/')) {
    const id = decodeURIComponent(pathname.slice('/api/nodes/'.length))
    const ok = await graph.removeNode(id)
    return ok ? json({ ok: true }) : notFound(`node '${id}'`)
  }

  // POST /api/edges  { source, target, kind, weight? }
  if (req.method === 'POST' && pathname === '/api/edges') {
    let body: any
    try {
      body = await req.json()
    } catch {
      return badRequest('body must be JSON')
    }
    if (!body?.source || !body?.target || !body?.kind) {
      return badRequest('source, target, kind are required')
    }
    const edge = await graph.upsertEdge(body)
    if (!edge) return badRequest('source or target node does not exist')
    return json(edge, 201)
  }

  // DELETE /api/edges/:id
  if (req.method === 'DELETE' && pathname.startsWith('/api/edges/')) {
    const id = decodeURIComponent(pathname.slice('/api/edges/'.length))
    const ok = await graph.removeEdge(id)
    return ok ? json({ ok: true }) : notFound(`edge '${id}'`)
  }

  return notFound(`route '${req.method} ${pathname}'`)
}

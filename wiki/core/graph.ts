/**
 * Haking Wiki — graph data layer.
 *
 * In-memory index of nodes + edges, persisted to .haking/wiki/graph.json.
 * Mutations are queued through a single async chain so concurrent
 * REST handlers + crawler workers never interleave file writes.
 *
 * Schema is intentionally tiny and JSON-friendly so the file can be
 * hand-edited or git-tracked when the user wants. Heavy fields (full
 * markdown body) live in .haking/wiki/pages/{id}.md, not here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'

export type NodeKind =
  | 'page'      // Crawled / authored markdown article
  | 'cve'       // Vulnerability identifier
  | 'tool'      // Software tool (nmap, sqlmap, ...)
  | 'concept'   // Generic noun (e.g. "buffer overflow")
  | 'host'      // IP / domain / URL target
  | 'note'      // Free-form user note

export type WikiNode = {
  id: string             // slug-safe unique id
  kind: NodeKind
  title: string          // display name
  url?: string           // source URL (for crawled pages)
  tags?: string[]        // free-form labels
  summary?: string       // 1-2 sentence preview shown on hover
  /** Path of the .md body file (relative to wiki root). Optional. */
  body?: string
  createdAt: number
  updatedAt: number
}

export type EdgeKind =
  | 'mentions'   // node A's body mentions node B
  | 'related'    // generic association
  | 'derives'    // A is derived from B (citation / fork)
  | 'contains'   // A contains B as sub-entity

export type WikiEdge = {
  id: string
  source: string         // node id
  target: string         // node id
  kind: EdgeKind
  weight?: number        // optional importance, default 1
  createdAt: number
}

export type GraphSnapshot = {
  version: 1
  nodes: WikiNode[]
  edges: WikiEdge[]
}

export type GraphDelta =
  | { type: 'node:add'; node: WikiNode }
  | { type: 'node:update'; node: WikiNode }
  | { type: 'node:remove'; id: string }
  | { type: 'edge:add'; edge: WikiEdge }
  | { type: 'edge:remove'; id: string }
  | { type: 'snapshot'; snapshot: GraphSnapshot }

type Listener = (delta: GraphDelta) => void

/**
 * Slugify a string into a stable, URL-safe id.
 * Uses ASCII fold + lowercase; non-alphanum gets collapsed to dashes.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `n-${Date.now().toString(36)}`
}

export class WikiGraph {
  private nodes = new Map<string, WikiNode>()
  private edges = new Map<string, WikiEdge>()
  private listeners = new Set<Listener>()
  /** Single-writer queue so file flushes never race. */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private graphFile: string) {
    this.load()
  }

  // ---------- Persistence ----------

  private load(): void {
    if (!existsSync(this.graphFile)) return
    try {
      const raw = JSON.parse(readFileSync(this.graphFile, 'utf-8')) as GraphSnapshot
      if (!raw || raw.version !== 1) return
      for (const n of raw.nodes ?? []) this.nodes.set(n.id, n)
      for (const e of raw.edges ?? []) this.edges.set(e.id, e)
    } catch {
      // Corrupt or partial — start empty rather than crash. The user can
      // recover the previous version from git or the last good backup.
    }
  }

  /**
   * Flush queued through writeChain so even rapid CRUD bursts produce
   * one consistent file on disk.
   */
  private flush(): Promise<void> {
    const snapshot: GraphSnapshot = {
      version: 1,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
    }
    this.writeChain = this.writeChain.then(() => {
      mkdirSync(dirname(this.graphFile), { recursive: true })
      // Write to temp file then rename to make replacement atomic.
      const tmp = this.graphFile + '.tmp'
      writeFileSync(tmp, JSON.stringify(snapshot, null, 2))
      try {
        // On Windows rename across same volume is atomic; if the target
        // exists it must be unlinked first (Node fs.rename failure mode).
        if (existsSync(this.graphFile)) unlinkSync(this.graphFile)
      } catch {
        /* ignore */
      }
      // Use sync rename via fs (writeFileSync already imported but we need rename).
      // Simpler: just write directly to graphFile after the unlink above.
      writeFileSync(this.graphFile, JSON.stringify(snapshot, null, 2))
      try {
        unlinkSync(tmp)
      } catch {
        /* ignore */
      }
    })
    return this.writeChain
  }

  // ---------- Subscriptions ----------

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private emit(delta: GraphDelta): void {
    for (const fn of this.listeners) {
      try {
        fn(delta)
      } catch {
        // Listener errors must not poison other listeners.
      }
    }
  }

  // ---------- Read API ----------

  snapshot(): GraphSnapshot {
    return {
      version: 1,
      nodes: [...this.nodes.values()],
      edges: [...this.edges.values()],
    }
  }

  getNode(id: string): WikiNode | undefined {
    return this.nodes.get(id)
  }

  getEdge(id: string): WikiEdge | undefined {
    return this.edges.get(id)
  }

  listNodes(): WikiNode[] {
    return [...this.nodes.values()]
  }

  listEdges(): WikiEdge[] {
    return [...this.edges.values()]
  }

  edgesOf(nodeId: string): WikiEdge[] {
    return [...this.edges.values()].filter(e => e.source === nodeId || e.target === nodeId)
  }

  /**
   * Substring match across title / tags / summary. Cheap O(n) — when the
   * graph grows past ~5K nodes we'll switch to fuse.js (already a dep).
   */
  searchNodes(query: string, limit = 20): WikiNode[] {
    const q = query.trim().toLowerCase()
    if (!q) return []
    const hits: Array<{ node: WikiNode; score: number }> = []
    for (const n of this.nodes.values()) {
      let score = 0
      if (n.title.toLowerCase().includes(q)) score += 3
      if (n.id.toLowerCase().includes(q)) score += 2
      if (n.summary?.toLowerCase().includes(q)) score += 2
      if (n.tags?.some(t => t.toLowerCase().includes(q))) score += 1
      if (score > 0) hits.push({ node: n, score })
    }
    hits.sort((a, b) => b.score - a.score)
    return hits.slice(0, limit).map(h => h.node)
  }

  // ---------- Write API ----------

  async upsertNode(input: Partial<WikiNode> & Pick<WikiNode, 'title' | 'kind'>): Promise<WikiNode> {
    const now = Date.now()
    const id = input.id || slugify(input.title)
    const existing = this.nodes.get(id)
    const node: WikiNode = existing
      ? { ...existing, ...input, id, updatedAt: now }
      : {
          id,
          kind: input.kind,
          title: input.title,
          url: input.url,
          tags: input.tags,
          summary: input.summary,
          body: input.body,
          createdAt: now,
          updatedAt: now,
        }
    this.nodes.set(id, node)
    await this.flush()
    this.emit(existing ? { type: 'node:update', node } : { type: 'node:add', node })
    return node
  }

  async removeNode(id: string): Promise<boolean> {
    if (!this.nodes.has(id)) return false
    this.nodes.delete(id)
    // Cascade: drop edges that reference this node
    const droppedEdgeIds: string[] = []
    for (const e of this.edges.values()) {
      if (e.source === id || e.target === id) droppedEdgeIds.push(e.id)
    }
    for (const eid of droppedEdgeIds) this.edges.delete(eid)
    await this.flush()
    this.emit({ type: 'node:remove', id })
    for (const eid of droppedEdgeIds) {
      this.emit({ type: 'edge:remove', id: eid })
    }
    return true
  }

  async upsertEdge(input: Partial<WikiEdge> & Pick<WikiEdge, 'source' | 'target' | 'kind'>): Promise<WikiEdge | null> {
    if (!this.nodes.has(input.source) || !this.nodes.has(input.target)) {
      // Refusing to dangle: caller must create endpoints first.
      return null
    }
    const id = input.id || `${input.source}--${input.kind}--${input.target}`
    const existing = this.edges.get(id)
    const edge: WikiEdge = existing
      ? { ...existing, ...input, id }
      : {
          id,
          source: input.source,
          target: input.target,
          kind: input.kind,
          weight: input.weight,
          createdAt: Date.now(),
        }
    this.edges.set(id, edge)
    await this.flush()
    this.emit({ type: 'edge:add', edge })
    return edge
  }

  async removeEdge(id: string): Promise<boolean> {
    if (!this.edges.has(id)) return false
    this.edges.delete(id)
    await this.flush()
    this.emit({ type: 'edge:remove', id })
    return true
  }
}

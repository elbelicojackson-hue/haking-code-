/**
 * Island WebSocket server — pushes session state to the floating island app.
 *
 * v1.2: multi-instance support via file-based aggregation + port leader
 * election.
 *
 *   - Every Haking Code instance writes its own state file at
 *     `~/.haking-island/sessions/{pid}.json` once per second.
 *   - Whoever wins port 7890 becomes the "hub": reads all session files,
 *     filters out stale ones (mtime > STALE_AFTER_MS), aggregates, and
 *     broadcasts to connected island webviews.
 *   - Non-hub instances also try to take over the port every 30s — this
 *     handles the case where the original hub crashed (port freed, the
 *     next survivor seamlessly inherits).
 *   - Stale session files (PIDs that died ungracefully) get unlinked by
 *     the hub on each poll, so a long-running daemon doesn't leak.
 *
 * Wire format (IslandState) intentionally keeps the single-session shape
 * from v1.0 backward-compatible: `sessions` is now multi-entry, `model` /
 * `totalTokens` / `totalCost` continue to reflect the AGGREGATE across all
 * live instances so the existing index.html renderer just works.
 */
import { WebSocketServer, type WebSocket } from 'ws'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { getModelUsage, getSessionId } from '../bootstrap/state.js'
import type { ModelUsage } from '../entrypoints/agentSdkTypes.js'

let wss: WebSocketServer | null = null
const clients = new Set<WebSocket>()
let hubPollTimer: ReturnType<typeof setInterval> | null = null
let writerTimer: ReturnType<typeof setInterval> | null = null
let leaderElectionTimer: ReturnType<typeof setInterval> | null = null
let lastBroadcastJson = ''
let exitHookInstalled = false

const PORT = 7890
const HOST = '127.0.0.1'
const WRITER_INTERVAL_MS = 1500
const HUB_POLL_INTERVAL_MS = 1000
const LEADER_RETRY_INTERVAL_MS = 30_000
/** Files older than this are considered dead and removed by the hub. */
const STALE_AFTER_MS = 8_000

const STARTED_AT = Date.now()

/** %APPDATA%\\haking-island on Windows; falls back gracefully elsewhere. */
function configRoot(): string {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'haking-island')
  }
  return join(homedir(), '.haking-island')
}

function sessionsDir(): string {
  const p = join(configRoot(), 'sessions')
  if (!existsSync(p)) mkdirSync(p, { recursive: true })
  return p
}

function ownSessionFile(): string {
  return join(sessionsDir(), `${process.pid}.json`)
}

export type SessionFile = {
  pid: number
  sessionId: string
  cwd: string
  startedAt: number
  lastUpdate: number
  model: string
  /** Same shape as STATE.modelUsage — keyed by full model name. */
  modelUsage: { [modelName: string]: Partial<ModelUsage> }
}

export type IslandState = {
  sessions: Array<{
    id: string
    name: string
    status: 'running' | 'idle'
    model?: string
    cwd?: string
    totalTokens?: number
    totalCost?: number
  }>
  model: string
  totalTokens: number
  totalCost: number
}

// CNY pricing kept identical to ModelStatsPanel.tsx — flash / pro promo / pro full.
const FLASH_PRICING = { hit: 0.02, miss: 1, out: 2 }
const PRO_PROMO_PRICING = { hit: 0.025, miss: 3, out: 6 }
const PRO_FULL_PRICING = { hit: 0.1, miss: 12, out: 24 }

function getProPricing(): { hit: number; miss: number; out: number } {
  return process.env.DEEPSEEK_PRO_FULL_PRICE === '1'
    ? PRO_FULL_PRICING
    : PRO_PROMO_PRICING
}

function priceFor(model: string): { hit: number; miss: number; out: number } | null {
  const lower = model.toLowerCase()
  if (lower.includes('flash')) return FLASH_PRICING
  if (lower.includes('pro')) return getProPricing()
  return null
}

function computeUsageStats(
  modelUsage: { [m: string]: Partial<ModelUsage> },
): { tokens: number; cny: number } {
  let tokens = 0
  let cny = 0
  for (const [name, u] of Object.entries(modelUsage)) {
    const inT = u.inputTokens ?? 0
    const outT = u.outputTokens ?? 0
    const cacheR = u.cacheReadInputTokens ?? 0
    const cacheW = u.cacheCreationInputTokens ?? 0
    tokens += inT + outT + cacheR + cacheW
    const p = priceFor(name)
    if (!p) continue
    cny +=
      (inT / 1_000_000) * p.miss +
      (cacheR / 1_000_000) * p.hit +
      (cacheW / 1_000_000) * p.miss +
      (outT / 1_000_000) * p.out
  }
  return { tokens, cny }
}

// ---------- Per-instance session file writer ----------

function writeOwnSessionFile(): void {
  const path = ownSessionFile()
  const data: SessionFile = {
    pid: process.pid,
    sessionId: String(getSessionId()),
    cwd: process.cwd(),
    startedAt: STARTED_AT,
    lastUpdate: Date.now(),
    model: process.env.ANTHROPIC_MODEL || 'deepseek-v4-pro',
    modelUsage: getModelUsage() as { [m: string]: Partial<ModelUsage> },
  }
  try {
    writeFileSync(path, JSON.stringify(data))
  } catch {
    // ignore — session reporting is best-effort
  }
}

function cleanupOwnSessionFile(): void {
  try {
    unlinkSync(ownSessionFile())
  } catch {
    // already gone
  }
}

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  const cleanup = () => {
    cleanupOwnSessionFile()
  }
  process.on('exit', cleanup)
  process.on('SIGINT', () => {
    cleanup()
    process.exit(0)
  })
  process.on('SIGTERM', () => {
    cleanup()
    process.exit(0)
  })
}

// ---------- Hub: read all session files, build aggregate, broadcast ----------

function readAllSessionFiles(): SessionFile[] {
  const dir = sessionsDir()
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const now = Date.now()
  const live: SessionFile[] = []
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    try {
      const stat = statSync(path)
      if (now - stat.mtimeMs > STALE_AFTER_MS) {
        // Reap stale file (instance crashed without exit hook firing).
        try {
          unlinkSync(path)
        } catch {
          /* ignore */
        }
        continue
      }
      const text = readFileSync(path, 'utf-8')
      const data = JSON.parse(text) as SessionFile
      // Sanity check on lastUpdate too — guard against clock skew on file mtime.
      if (
        typeof data.lastUpdate === 'number' &&
        now - data.lastUpdate > STALE_AFTER_MS
      ) {
        try {
          unlinkSync(path)
        } catch {
          /* ignore */
        }
        continue
      }
      live.push(data)
    } catch {
      // Malformed file — skip.
    }
  }
  return live
}

function buildAggregateState(): IslandState {
  const files = readAllSessionFiles()
  if (files.length === 0) {
    // Fallback: at least surface OURSELVES so the island shows current
    // process even before the writer interval has run.
    const usage = getModelUsage() as { [m: string]: Partial<ModelUsage> }
    const { tokens, cny } = computeUsageStats(usage)
    return {
      sessions: [
        {
          id: String(getSessionId()),
          name: `Haking Code (${basename(process.cwd())})`,
          status: 'running',
          model: process.env.ANTHROPIC_MODEL || 'deepseek-v4-pro',
          cwd: process.cwd(),
          totalTokens: tokens,
          totalCost: cny,
        },
      ],
      model: process.env.ANTHROPIC_MODEL || 'deepseek-v4-pro',
      totalTokens: tokens,
      totalCost: cny,
    }
  }

  // Sort: most-recently-active first so the top entry is what the user
  // is probably looking at.
  files.sort((a, b) => b.lastUpdate - a.lastUpdate)

  const sessions = files.map(f => {
    const { tokens, cny } = computeUsageStats(f.modelUsage)
    return {
      id: f.sessionId,
      name: `Haking Code (${basename(f.cwd)})`,
      status: 'running' as const,
      model: f.model,
      cwd: f.cwd,
      totalTokens: tokens,
      totalCost: cny,
    }
  })

  let totalTokens = 0
  let totalCost = 0
  for (const s of sessions) {
    totalTokens += s.totalTokens || 0
    totalCost += s.totalCost || 0
  }

  return {
    sessions,
    model: files[0]?.model ?? 'deepseek-v4-pro',
    totalTokens,
    totalCost,
  }
}

function broadcast(): void {
  if (!wss || clients.size === 0) return
  const json = JSON.stringify(buildAggregateState())
  if (json === lastBroadcastJson) return
  lastBroadcastJson = json
  for (const ws of clients) {
    try {
      ws.send(json)
    } catch {
      // best-effort
    }
  }
}

// ---------- Leader election ----------

function tryBecomeHub(): void {
  if (wss) return // already serving
  try {
    const server = new WebSocketServer({ port: PORT, host: HOST })
    server.on('connection', ws => {
      clients.add(ws)
      try {
        ws.send(JSON.stringify(buildAggregateState()))
        lastBroadcastJson = JSON.stringify(buildAggregateState())
      } catch {
        /* ignore */
      }
      ws.on('close', () => clients.delete(ws))
    })
    server.on('error', () => {
      // Port lost mid-flight (rare). Drop role and let the retry loop
      // re-acquire on the next tick.
      try {
        server.close()
      } catch {
        /* ignore */
      }
      wss = null
      if (hubPollTimer) {
        clearInterval(hubPollTimer)
        hubPollTimer = null
      }
    })
    wss = server
    hubPollTimer = setInterval(broadcast, HUB_POLL_INTERVAL_MS)
  } catch {
    // Port busy — another Haking Code instance owns the hub. We stay as
    // a session-file writer only and try again later.
  }
}

// ---------- Public API ----------

export function startIslandServer(): void {
  installExitHook()

  // Always write our own session file, hub or not.
  writeOwnSessionFile()
  writerTimer = setInterval(writeOwnSessionFile, WRITER_INTERVAL_MS)

  // Try to become the hub immediately. If port is busy, we just write
  // session files and wait. The retry loop will reattempt periodically.
  tryBecomeHub()
  leaderElectionTimer = setInterval(tryBecomeHub, LEADER_RETRY_INTERVAL_MS)
}

/** @deprecated Aggregation now happens via session files. No-op. */
export function updateIslandState(_partial: Partial<IslandState>): void {
  broadcast()
}

/** @deprecated Aggregation now happens via session files. No-op. */
export function addIslandTokens(_tokens: number, _cost: number): void {
  broadcast()
}

export function stopIslandServer(): void {
  if (writerTimer) {
    clearInterval(writerTimer)
    writerTimer = null
  }
  if (hubPollTimer) {
    clearInterval(hubPollTimer)
    hubPollTimer = null
  }
  if (leaderElectionTimer) {
    clearInterval(leaderElectionTimer)
    leaderElectionTimer = null
  }
  wss?.close()
  wss = null
  clients.clear()
  lastBroadcastJson = ''
  cleanupOwnSessionFile()
}

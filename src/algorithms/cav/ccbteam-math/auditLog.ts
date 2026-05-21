/**
 * T10 — Audit Log writer (append-only NDJSON).
 *
 * Sidecar consumes 8 event kinds and serializes each as one line of
 * NDJSON to `<sessionDir>/ccbteam-math-audit.jsonl`. The file is
 * **append-only** and **never read back** at runtime (R8-3, R8-4).
 *
 * Hard rules (audited):
 *   - No read API exposed (R8-4 + R5-9 enforcement).
 *   - Every event line ends with `\n` so a partial-write crash still
 *     leaves valid NDJSON (R8-7).
 *   - Lines exceeding 8 KB are length-truncated on the `details` /
 *     `explanation` fields before serialization (R8-5).
 *   - Failures are caught and silently swallowed — sidecar manages
 *     degradation tracking; this layer just promises "best effort".
 *
 * Cross-references:
 *   - .kiro/specs/super-agent-cluster/requirements.md → R8
 *   - .kiro/specs/super-agent-cluster/design.md → "Component 3"
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { logForDebugging } from '../../../utils/debug.js'
import type { AuditWriter, SidecarAuditEvent } from './types.js'

/** Maximum NDJSON line length, including trailing newline (R8-5). */
const MAX_LINE_BYTES = 8 * 1024

/* -------------------------------------------------------------------------- */
/* openAuditWriter                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Construct an {@link AuditWriter} bound to a target NDJSON file.
 *
 * - Parent directory is created lazily on first write.
 * - Calls to `write` are **fire-and-forget** with internal serialization
 *   so writes preserve event order without blocking the sidecar
 *   polling loop.
 * - `close()` resolves after any pending write settles.
 */
export function openAuditWriter(filePath: string): AuditWriter {
  let pending: Promise<void> = Promise.resolve()
  let closed = false
  let directoryReady = false

  const ensureDir = async (): Promise<void> => {
    if (directoryReady) return
    try {
      await mkdir(dirname(filePath), { recursive: true })
    } catch (err) {
      logForDebugging(
        `[ccbteam-math/auditLog] mkdir failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { level: 'error' },
      )
    }
    directoryReady = true
  }

  const writeLine = async (line: string): Promise<void> => {
    try {
      await ensureDir()
      await appendFile(filePath, line, 'utf8')
    } catch (err) {
      logForDebugging(
        `[ccbteam-math/auditLog] append failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { level: 'error' },
      )
    }
  }

  return {
    write(event: SidecarAuditEvent): Promise<void> {
      if (closed) return Promise.resolve()
      const line = serializeEvent(event)
      pending = pending.then(() => writeLine(line))
      return pending
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      // Wait for any pending writes to settle before resolving.
      await pending
    },
  }
}

/* -------------------------------------------------------------------------- */
/* serialization                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Serialize one event to a single NDJSON line. Truncates `details` /
 * `explanation` -shaped strings to keep the line ≤ {@link MAX_LINE_BYTES}.
 */
export function serializeEvent(event: SidecarAuditEvent): string {
  let candidate = JSON.stringify(event) + '\n'
  if (Buffer.byteLength(candidate, 'utf8') <= MAX_LINE_BYTES) {
    return candidate
  }
  // Try truncating known long fields first, then fall back to a
  // sentinel placeholder.
  const trimmed = truncateLongFields(event)
  candidate = JSON.stringify(trimmed) + '\n'
  if (Buffer.byteLength(candidate, 'utf8') <= MAX_LINE_BYTES) {
    return candidate
  }
  // Last resort: replace event with a degradation placeholder. We
  // truncate the sessionId too so an oversize id can't bust the budget.
  const sid = (event as { sessionId?: string }).sessionId ?? ''
  const fallback = {
    kind: 'degradation',
    sessionId: TRUNC(sid, 200),
    reason: 'audit-event-too-large',
    details: `event kind=${event.kind} exceeded ${MAX_LINE_BYTES}B after truncation`,
    timestamp: Date.now(),
  } satisfies SidecarAuditEvent
  return JSON.stringify(fallback) + '\n'
}

const TRUNC = (s: string, max = 500) =>
  s.length <= max ? s : s.slice(0, max - 3) + '...'

function truncateLongFields(event: SidecarAuditEvent): SidecarAuditEvent {
  switch (event.kind) {
    case 'degradation':
      return { ...event, details: TRUNC(event.details, 1000) }
    case 'round.epistemic-violation':
      return { ...event, details: TRUNC(event.details, 500) }
    case 'round.cr-eig':
      return {
        ...event,
        ranking: event.ranking.map(r => ({
          ...r,
          breakdown: r.breakdown,
        })),
      }
    case 'round.gradient-ranking':
      return {
        ...event,
        rankedGradient: event.rankedGradient.map(r => ({
          ...r,
        })),
      }
    default:
      return event
  }
}

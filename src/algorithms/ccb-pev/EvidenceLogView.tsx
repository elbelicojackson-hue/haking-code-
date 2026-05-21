/**
 * EvidenceLogView — pure functional Ink component that renders the most
 * recent N tool-evidence rows from the PEV ledger.
 *
 * Layout convention (per design.md Component 11 / R11-4):
 *   - Show the LAST `maxRows` entries (default 5). Most recent at the
 *     bottom — keeps the streaming-log feel of a tail.
 *   - Each row is one line: `<E-id> [<glyph>] (round R, agent A,
 *     plan T) <truncated digest 80>`.
 *   - Verdict glyph + colour is consistent with HypothesisTreeView's
 *     status palette so the two panels read as a unified system.
 *
 * Pure: no useState, no useEffect, no I/O. The runner re-renders on
 * every `ledger-update` event.
 */

import { Box, Text } from '@anthropic/ink'

import type { ToolEvidence } from '../cav/pev/ledger.js'
import type { Verdict } from '../cav/pev/protocol.js'

type Props = {
  readonly evidenceLog: readonly ToolEvidence[]
  /** Default 5 (R11-4). */
  readonly maxRows?: number
}

const DEFAULT_MAX_ROWS = 5

const VERDICT_RENDER: Record<
  Verdict,
  { glyph: string; color?: 'success' | 'error' | 'warning'; dim: boolean }
> = {
  confirms: { glyph: '✓', color: 'success', dim: false },
  falsifies: { glyph: '✗', color: 'error', dim: false },
  mutates: { glyph: '⤳', color: 'warning', dim: false },
  inconclusive: { glyph: '?', dim: true },
}

function truncateOneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

export function EvidenceLogView(props: Props): React.ReactNode {
  const { evidenceLog } = props
  const maxRows = props.maxRows ?? DEFAULT_MAX_ROWS

  if (evidenceLog.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Evidence log</Text>
        <Text dimColor>(no evidence yet)</Text>
      </Box>
    )
  }

  const tail = evidenceLog.slice(-maxRows)
  const hidden = evidenceLog.length - tail.length

  return (
    <Box flexDirection="column">
      <Text bold>
        Evidence log (last {tail.length} of {evidenceLog.length})
      </Text>
      {hidden > 0 ? (
        <Text dimColor>… ({hidden} earlier entries elided)</Text>
      ) : null}
      {tail.map(ev => (
        <EvidenceRow key={ev.id} ev={ev} />
      ))}
    </Box>
  )
}

function EvidenceRow({ ev }: { ev: ToolEvidence }): React.ReactNode {
  const render = VERDICT_RENDER[ev.verdict]
  const digest = truncateOneLine(ev.resultDigest, 80)
  const line = `${ev.id} [${render.glyph}] (round ${ev.round}, agent ${ev.agentId}, plan ${ev.toolName}, tested ${ev.testedHypothesis}) ${digest}`
  if (render.color) {
    return (
      <Text color={render.color} dimColor={render.dim}>
        {line}
      </Text>
    )
  }
  return <Text dimColor={render.dim}>{line}</Text>
}

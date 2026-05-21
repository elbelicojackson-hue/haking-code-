/**
 * AgentStatusBar — pure functional Ink component showing per-agent
 * lifecycle status during a PEV run.
 *
 * Each provider gets one row with a glyph + colour indicating its
 * current phase: idle → thinking → tool-running → done (or error).
 * The runner updates the status map on every relevant `PevRoundEvent`;
 * this component just renders the snapshot.
 *
 * Pure: no useState, no useEffect, no I/O.
 *
 * Cross-references:
 *   - .kiro/specs/ccb-pev-re-execution-loop/design.md → Component 11
 *   - .kiro/specs/ccb-pev-re-execution-loop/requirements.md → R11-4
 */

import { Box, Text } from '@anthropic/ink'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type AgentStatus =
  | { status: 'idle' }
  | { status: 'thinking' }
  | { status: 'tool-running'; planId: string }
  | { status: 'done' }
  | { status: 'error'; detail: string }

type Props = {
  readonly providers: readonly { id: string; displayName: string }[]
  readonly statuses: ReadonlyMap<string, AgentStatus>
  /** Optional EIG scores per agent (from scheduler directive). */
  readonly eigScores?: ReadonlyMap<string, number>
}

/* -------------------------------------------------------------------------- */
/* Render helpers                                                             */
/* -------------------------------------------------------------------------- */

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

function renderStatus(st: AgentStatus | undefined): {
  glyph: string
  text: string
  color?: 'success' | 'error' | 'warning' | 'claude'
  dim: boolean
} {
  if (!st || st.status === 'idle') {
    return { glyph: '○', text: 'idle', dim: true }
  }
  switch (st.status) {
    case 'thinking':
      return { glyph: '⏵', text: 'thinking', color: 'claude', dim: false }
    case 'tool-running':
      return {
        glyph: '⚙',
        text: `tool: ${truncate(st.planId, 24)}`,
        color: 'warning',
        dim: false,
      }
    case 'done':
      return { glyph: '✓', text: 'done', color: 'success', dim: false }
    case 'error':
      return {
        glyph: '✗',
        text: `error: ${truncate(st.detail, 40)}`,
        color: 'error',
        dim: false,
      }
  }
}

/* -------------------------------------------------------------------------- */
/* Public component                                                           */
/* -------------------------------------------------------------------------- */

export function AgentStatusBar(props: Props): React.ReactNode {
  const { providers, statuses, eigScores } = props

  if (providers.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Agents</Text>
        <Text dimColor>(no providers)</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold>Agents</Text>
      {providers.map(p => {
        const st = statuses.get(p.id)
        const r = renderStatus(st)
        const eigVal = eigScores?.get(p.id)
        const eigSuffix = eigVal != null ? ` · EIG=${eigVal.toFixed(3)}b` : ''
        const label = `${r.glyph} ${p.displayName}(${p.id}) · ${r.text}${eigSuffix}`
        if (r.color) {
          return (
            <Text key={p.id} color={r.color} dimColor={r.dim}>
              {label}
            </Text>
          )
        }
        return (
          <Text key={p.id} dimColor={r.dim}>
            {label}
          </Text>
        )
      })}
    </Box>
  )
}

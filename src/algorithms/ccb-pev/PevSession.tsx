/**
 * PevSession — stateful Ink component that drives the PEV main loop and
 * renders the live hypothesis tree, evidence log, and agent status bar.
 *
 * Lifecycle:
 *   1. On mount: kicks off `runPev`, accumulates events into local state.
 *   2. On each `PevRoundEvent`: updates the three sub-component views.
 *   3. On `run-end`: builds the final PevEvalLog, writes it to disk,
 *      calls `onDone` with a markdown summary.
 *   4. On Esc / unmount: aborts the runner via `AbortController`.
 *
 * Cross-references:
 *   - .kiro/specs/ccb-pev-re-execution-loop/design.md → Component 11
 *   - .kiro/specs/ccb-pev-re-execution-loop/requirements.md → R11-4,
 *     R11-5, R11-6
 */

import { dirname } from 'node:path'

import { Box, Text } from '@anthropic/ink'
import { useEffect, useMemo, useState } from 'react'

import { getSessionId } from '../../bootstrap/state.js'
import { getCavLogPath } from '../../services/cav/recorder.js'
import type { ArenaProvider } from '../../services/cav/arena/providers.js'
import {
  buildPevEvalLog,
  writePevEvalLog,
  type PevEvalLogPerAgentOutput,
  type PevEvalLogRound,
} from '../cav/pev/persistence.js'
import {
  runPev,
  type PevRoundEvent,
  type PevRunOpts,
  type SharedLedger,
  type StopReason,
} from '../cav/pev/pevRunner.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

import type { CcbPevBudget } from './parseArgs.js'
import { AgentStatusBar, type AgentStatus } from './AgentStatusBar.js'
import { EvidenceLogView } from './EvidenceLogView.js'
import { HypothesisTreeView } from './HypothesisTreeView.js'

/* -------------------------------------------------------------------------- */
/* Props                                                                      */
/* -------------------------------------------------------------------------- */

export type PevSessionProps = {
  targetBinary: { path: string; sha256: string; size: number }
  goal: string | null
  budget: CcbPevBudget
  providers: readonly ArenaProvider[]
  onDone: LocalJSXCommandOnDone
  /** Injected by ccb-pev.tsx — wraps dispatchArena per-provider. */
  providerAdapter?: PevRunOpts['providerAdapter']
  /** Injected by ccb-pev.tsx — stub or real tool routing. */
  toolAdapter?: PevRunOpts['toolAdapter']
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export function PevSession({
  targetBinary,
  goal,
  budget,
  providers,
  onDone,
  providerAdapter,
  toolAdapter,
}: PevSessionProps): React.ReactNode {
  // ─── State ──────────────────────────────────────────────────────────
  const [currentRound, setCurrentRound] = useState(0)
  const [agentsRespondedThisRound, setAgentsResponded] = useState(0)
  const [toolCallsThisRound, setToolCalls] = useState(0)
  const [stopReason, setStopReason] = useState<StopReason | null>(null)
  const [latestLedger, setLatestLedger] = useState<SharedLedger | null>(null)
  const [agentStatuses, setAgentStatuses] = useState<Map<string, AgentStatus>>(
    () => new Map(providers.map(p => [p.id, { status: 'idle' as const }])),
  )
  const [eigScores, setEigScores] = useState<Map<string, number>>(new Map())
  const [persistedPath, setPersistedPath] = useState<string | null>(null)

  // ─── Derived ────────────────────────────────────────────────────────
  const baseName = useMemo(() => {
    const segs = targetBinary.path.split(/[\\/]/u)
    return segs[segs.length - 1] ?? targetBinary.path
  }, [targetBinary.path])
  const sha8 = targetBinary.sha256.slice(0, 8)

  const initialClaim = useMemo(
    () => goal ?? `逆向分析目标二进制 ${baseName}: 加壳/编译器/算法/能力族鉴别。`,
    [goal, baseName],
  )

  // ─── Main loop effect ───────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const ac = new AbortController()
    const startedAt = Date.now()

    const rounds: PevEvalLogRound[] = []
    let currentRoundOutputs: PevEvalLogPerAgentOutput[] = []
    let currentRoundIndex = 0

    void (async () => {
      try {
        for await (const event of runPev({
          providers,
          targetBinary,
          initialClaim,
          budget,
          signal: ac.signal,
          providerAdapter,
          toolAdapter,
        })) {
          if (cancelled) break
          handleEvent(event)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (!cancelled) {
          onDone(`PEV 主循环异常退出: ${msg}`, { display: 'system' })
        }
      }
    })()

    function handleEvent(ev: PevRoundEvent): void {
      switch (ev.kind) {
        case 'round-start': {
          currentRoundIndex = ev.round
          currentRoundOutputs = []
          setCurrentRound(ev.round)
          setAgentsResponded(0)
          setToolCalls(0)
          // Reset all agents to thinking
          setAgentStatuses(
            new Map(providers.map(p => [p.id, { status: 'thinking' as const }])),
          )
          break
        }
        case 'agent-output': {
          const entry: PevEvalLogPerAgentOutput = ev.parseResult.ok
            ? {
                agentId: ev.agentId,
                pev: ev.parseResult.parsed,
                parseResult: { ok: true, layerHit: ev.parseResult.layerHit },
              }
            : {
                agentId: ev.agentId,
                parseResult: {
                  ok: false,
                  errorKind: ev.parseResult.errorKind,
                  detail: ev.parseResult.detail,
                },
              }
          currentRoundOutputs.push(entry)
          setAgentsResponded(n => n + 1)
          // Update agent status
          setAgentStatuses(prev => {
            const next = new Map(prev)
            if (ev.parseResult.ok) {
              next.set(ev.agentId, { status: 'done' })
            } else {
              const detail = `${ev.parseResult.errorKind}: ${(ev.parseResult.detail ?? '').slice(0, 80)}`
              next.set(ev.agentId, { status: 'error', detail })
            }
            return next
          })
          break
        }
        case 'ledger-update': {
          setLatestLedger(ev.ledger)
          break
        }
        case 'tool-call-start': {
          setToolCalls(n => n + 1)
          setAgentStatuses(prev => {
            const next = new Map(prev)
            next.set(ev.agentId, { status: 'tool-running', planId: ev.planId })
            return next
          })
          break
        }
        case 'tool-call-complete': {
          setAgentStatuses(prev => {
            const next = new Map(prev)
            next.set(ev.agentId, { status: 'done' })
            return next
          })
          break
        }
        case 'round-end': {
          rounds.push({
            round: currentRoundIndex,
            perAgentOutputs: currentRoundOutputs,
          })
          setLatestLedger(ev.ledger)
          break
        }
        case 'run-end': {
          if (cancelled) return
          setStopReason(ev.reason)
          setAgentStatuses(
            new Map(providers.map(p => [p.id, { status: 'done' as const }])),
          )
          void finalise(ev, rounds, startedAt)
          break
        }
      }
    }

    async function finalise(
      ev: Extract<PevRoundEvent, { kind: 'run-end' }>,
      finalRounds: readonly PevEvalLogRound[],
      startTs: number,
    ): Promise<void> {
      const sessionId = getSessionId()
      const log = buildPevEvalLog({
        sessionId,
        startedAt: startTs,
        endedAt: Date.now(),
        targetBinary,
        initialClaim,
        budget,
        finalLedger: ev.finalLedger,
        rounds: finalRounds,
        stopReason: ev.reason,
        ...(ev.detail !== undefined ? { stopDetail: ev.detail } : {}),
      })

      const sessionDir = dirname(getCavLogPath(sessionId))
      let path: string | null = null
      try {
        const result = await writePevEvalLog({ sessionDir, sessionId, log })
        if (result.ok) path = result.path
      } catch {
        // writePevEvalLog never throws by contract; defence-in-depth.
      }
      setPersistedPath(path)

      const summary = buildSummary({
        targetBinary,
        baseName,
        sha8,
        goal,
        providers,
        budget,
        finalLedger: ev.finalLedger,
        rounds: finalRounds,
        stopReason: ev.reason,
        stopDetail: ev.detail,
        persistedPath: path,
      })
      onDone(summary, { display: 'user' })
    }

    return () => {
      cancelled = true
      ac.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ─── Render ─────────────────────────────────────────────────────────
  const totalRounds = budget.maxRounds
  const goalSnippet = goal ?? '(no explicit goal)'
  const ps = latestLedger?.parseStats
  const budgetRemaining = latestLedger?.toolBudgetRemaining ?? budget.maxToolCalls

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="claude"
      paddingX={1}
    >
      {/* Header */}
      <Text bold>
        🎯 /ccb-pev · target: {baseName}({sha8}) · round {currentRound}/
        {totalRounds} · budget tools {budgetRemaining}/{budget.maxToolCalls}
      </Text>
      <Text dimColor>
        goal: {truncate(goalSnippet, 80)} · parse stats: L1=
        {ps?.layer1Hits ?? 0} L2={ps?.layer2Hits ?? 0} L3=
        {ps?.layer3Hits ?? 0} failed={ps?.parseFailures ?? 0}
      </Text>

      {/* Hypothesis tree */}
      <HypothesisTreeView
        hypotheses={latestLedger?.hypotheses ?? new Map()}
      />

      {/* Evidence log (last 5) */}
      <EvidenceLogView evidenceLog={latestLedger?.evidenceLog ?? []} />

      {/* Agent status bar */}
      <AgentStatusBar
        providers={providers.map(p => ({
          id: p.id,
          displayName: p.displayName,
        }))}
        statuses={agentStatuses}
        eigScores={eigScores}
      />

      {/* Footer */}
      {stopReason ? (
        <Text dimColor>
          ✓ stop reason: {stopReason}
          {persistedPath ? ` · .pev.json: ${persistedPath}` : ''}
        </Text>
      ) : (
        <Text dimColor>
          dispatching round {currentRound}: {agentsRespondedThisRound}/
          {providers.length} agents · {toolCallsThisRound} tool calls · Esc to
          cancel
        </Text>
      )}
    </Box>
  )
}

/* -------------------------------------------------------------------------- */
/* Markdown summary builder                                                   */
/* -------------------------------------------------------------------------- */

type SummaryArgs = {
  targetBinary: { path: string; sha256: string; size: number }
  baseName: string
  sha8: string
  goal: string | null
  providers: readonly ArenaProvider[]
  budget: CcbPevBudget
  finalLedger: SharedLedger
  rounds: readonly PevEvalLogRound[]
  stopReason: StopReason
  stopDetail?: string
  persistedPath: string | null
}

function buildSummary(args: SummaryArgs): string {
  const {
    baseName,
    sha8,
    goal,
    providers,
    budget,
    finalLedger,
    rounds,
    stopReason,
    stopDetail,
    persistedPath,
  } = args

  const lines: string[] = []
  lines.push('# 🎯 /ccb-pev · 运行摘要')
  lines.push('')
  lines.push(`**目标**: ${baseName} · sha256 \`${sha8}…\``)
  if (goal) lines.push(`**任务**: ${goal}`)
  lines.push(
    `**调度**: ${providers.length} agents · ${rounds.length} 轮 · budget rounds=${budget.maxRounds}, tools=${budget.maxToolCalls}, tokens=${budget.maxTokens}`,
  )
  lines.push(
    `**停机**: \`${stopReason}\`${stopDetail ? ` — ${stopDetail}` : ''}`,
  )
  lines.push('')

  const counts = countByStatus(finalLedger)
  lines.push('## Hypothesis ledger')
  lines.push('')
  lines.push(`- total: ${finalLedger.hypotheses.size}`)
  lines.push(`- open: ${counts.open}`)
  lines.push(`- evidence: ${counts.evidence}`)
  lines.push(`- falsified: ${counts.falsified}`)
  lines.push(`- mutated: ${counts.mutated}`)
  lines.push(`- stale: ${counts.stale}`)
  lines.push(`- evidence log entries: ${finalLedger.evidenceLog.length}`)
  lines.push('')

  // Hypothesis tree (text form for the markdown transcript)
  lines.push('## Hypothesis tree')
  lines.push('')
  for (const h of finalLedger.hypotheses.values()) {
    lines.push(`- \`${h.id}\` [${h.status}] (${h.kind}) conf=${h.confidence.toFixed(2)} — ${h.text.slice(0, 100)}`)
  }
  lines.push('')

  // Evidence trail
  if (finalLedger.evidenceLog.length > 0) {
    lines.push('## Evidence trail')
    lines.push('')
    for (const ev of finalLedger.evidenceLog) {
      lines.push(`- \`${ev.id}\` [${ev.verdict}] round=${ev.round} agent=${ev.agentId} tool=${ev.toolName} tested=${ev.testedHypothesis}`)
    }
    lines.push('')
  }

  // Information Efficiency (R6 of EIG spec)
  const toolCalls = finalLedger.evidenceLog.length
  if (toolCalls > 0) {
    const resolvedCount = counts.evidence + counts.falsified
    const efficiency = resolvedCount / toolCalls
    lines.push('## Information Efficiency')
    lines.push('')
    lines.push(`- tool calls: ${toolCalls}`)
    lines.push(`- hypotheses resolved (evidence + falsified): ${resolvedCount}`)
    lines.push(`- efficiency ratio: ${efficiency.toFixed(2)} resolved/call`)
    lines.push('')
  }

  if (persistedPath) {
    lines.push(`📁 Full transcript: \`${persistedPath}\``)
  } else {
    lines.push('⚠ persistence write failed (see debug log)')
  }
  return lines.join('\n')
}

function countByStatus(ledger: SharedLedger): {
  open: number
  evidence: number
  falsified: number
  mutated: number
  stale: number
} {
  const out = { open: 0, evidence: 0, falsified: 0, mutated: 0, stale: 0 }
  for (const h of ledger.hypotheses.values()) {
    out[h.status] += 1
  }
  return out
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

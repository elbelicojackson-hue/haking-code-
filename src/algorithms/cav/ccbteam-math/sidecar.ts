/**
 * T11 — Sidecar Bootstrap + Polling.
 *
 * The sidecar is the **only** runtime entry point of the Math Layer. It
 * is mounted from the command layer (T13) when `--strategy=observe` is
 * active, and tears down at session end.
 *
 * Hard rules (audited):
 *   - Pure observer (R5). Sidecar reads CAV records via the existing
 *     recorder ring; never modifies prompt / dispatcher / progress.
 *   - `strategy === 'prompt-only'` → `startSidecar` returns `null` and
 *     does NOTHING — no file, no timer, no event subscription (R5-5).
 *   - Polling is fail-soft (R7-6): any thrown error in the math layer
 *     becomes a `degradation` audit event; sidecar continues.
 *   - 3-strike degrade: after `SIDECAR_DEGRADE_AFTER_MISSES` consecutive
 *     misses (or budget overruns) we stop polling but keep the writer
 *     alive so the final `session.end` still flushes.
 *   - `stop()` is idempotent.
 *
 * Cross-references:
 *   - .kiro/specs/super-agent-cluster/requirements.md → R5, R7-6, R8,
 *     R9, R13
 *   - .kiro/specs/super-agent-cluster/design.md → "Component 1 / 4 /
 *     Sidecar Lifecycle"
 */

import { getProfileById } from '../../../commands/ccbteam/profiles/index.js'
import { join } from 'node:path'
import {
  cavWeightedConsensus,
} from '../analyzer.js'
import { getRecentCavRecords } from '../recorder.js'
import { logForDebugging } from '../../../utils/debug.js'
import { parseAndCheckEpistemic } from '../ccbteam-discipline/epistemicParser.js'
import { openAuditWriter } from './auditLog.js'
import {
  SIDECAR_DEGRADE_AFTER_MISSES,
  SIDECAR_POLL_BUDGET_MS,
  SIDECAR_POLL_INTERVAL_MS,
} from './constants.js'
import { computeCausalConfidence } from '../pev/causalEngine.js'
import { exploitability } from './exploitability.js'
import { rankGradients } from './rankGradients.js'
import { createEmptyLedger } from '../pev/ledger.js'
import type {
  AuditWriter,
  CavRecord,
  EpistemicVerdict,
  GradientId,
  RankedGradient,
  SerializedRankedGradient,
  SharedLedger,
  SidecarHandle,
  SidecarOptions,
} from './types.js'

// Re-export the public boundary surface so the command layer (T13) has
// a single import path. R5-3 static-scan whitelist pins this entry.
export type { SidecarHandle, SidecarOptions } from './types.js'

/* -------------------------------------------------------------------------- */
/* Internal state per sidecar instance                                        */
/* -------------------------------------------------------------------------- */

type SidecarState = {
  readonly opts: SidecarOptions
  readonly writer: AuditWriter
  /** Set of (agentId|turn) keys we've already processed. */
  readonly seenKeys: Set<string>
  /** Set of agentIds previously flagged for boundary violation (R13 E5). */
  readonly flaggedAgents: Set<string>
  /** Cumulative CR-EIG bits observed across all rounds. */
  totalCrEig: number
  /** Most recent ε_t reading; null until first poll lands. */
  lastEpsilon: number | null
  /** Causal-fraction info accumulator (causal-confirm count vs total interventions). */
  causalCausalConfirms: number
  causalInterventionTotal: number
  /** Trust-weighted α drift (latest, written by polling). */
  alphaDrift: number
  /** Total tool calls observed via causal evidence count proxy. */
  toolCallCount: number
  /** Round counter — incremented each time we observe a new turn. */
  roundCursor: number
  /** Consecutive miss counter for polling degradation. */
  missCount: number
  /** Set true once polling has been disarmed (degraded or stopped). */
  disarmed: boolean
  /** Reason recorded for the eventual session.end event. */
  endReason: string
  /** Set when sidecar.stop() has been called. */
  closed: boolean
  /** Per-round epistemic violation log for the final report. */
  epistemicViolationsByAgent: Map<string, string[]>
}

/* -------------------------------------------------------------------------- */
/* startSidecar                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Mount a sidecar for a ccbteam session. Returns `null` (no-op) when
 * `strategy !== 'observe'` so callers can use `if (handle) ...`.
 */
export function startSidecar(opts: SidecarOptions): SidecarHandle | null {
  if (opts.strategy !== 'observe') {
    return null
  }

  const auditPath = join(opts.sessionDir, 'ccbteam-math-audit.jsonl')
  const writer = openAuditWriter(auditPath)

  const state: SidecarState = {
    opts,
    writer,
    seenKeys: new Set<string>(),
    flaggedAgents: new Set<string>(),
    totalCrEig: 0,
    lastEpsilon: null,
    causalCausalConfirms: 0,
    causalInterventionTotal: 0,
    alphaDrift: 0,
    toolCallCount: 0,
    roundCursor: 0,
    missCount: 0,
    disarmed: false,
    endReason: 'natural',
    closed: false,
    epistemicViolationsByAgent: new Map(),
  }

  // session.start
  void writer.write({
    kind: 'session.start',
    sessionId: opts.sessionId,
    profileId: String(opts.profileId),
    weights: opts.weights,
    timestamp: Date.now(),
  })

  // setInterval polling
  const intervalId = setInterval(() => {
    if (state.disarmed) return
    runPollTick(state).catch(err => {
      logForDebugging(
        `[ccbteam-math/sidecar] poll tick failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { level: 'error' },
      )
    })
  }, SIDECAR_POLL_INTERVAL_MS)

  // Don't keep the Node process alive on this timer alone; the command
  // layer's task lifecycle owns shutdown via stop().
  if (typeof intervalId.unref === 'function') intervalId.unref()

  return {
    async stop(): Promise<void> {
      if (state.closed) return
      state.closed = true
      state.disarmed = true
      clearInterval(intervalId)
      // One final poll for any straggler records.
      try {
        await runPollTick(state)
      } catch {
        /* swallow */
      }
      // session.end with totals
      try {
        await writer.write({
          kind: 'session.end',
          sessionId: opts.sessionId,
          reason: state.endReason,
          totalCrEig: state.totalCrEig,
          finalEpsilon: state.lastEpsilon,
          timestamp: Date.now(),
        })
      } catch {
        /* swallow */
      }
      await writer.close()
    },
    totalCrEigBits(): number {
      return state.totalCrEig
    },
    currentEpsilon(): number | null {
      return state.lastEpsilon
    },
    renderInformationEfficiencyMarkdown(): string {
      return renderInformationEfficiencyMarkdown(state)
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Poll tick                                                                  */
/* -------------------------------------------------------------------------- */

async function runPollTick(state: SidecarState): Promise<void> {
  const t0 = Date.now()
  let observedNew = false
  try {
    const records = getRecentCavRecords(state.opts.sessionId)
    const newRecords: CavRecord[] = []
    for (const r of records) {
      const key = `${r.agentId}|${r.turn}`
      if (state.seenKeys.has(key)) continue
      state.seenKeys.add(key)
      newRecords.push(r)
    }

    if (newRecords.length === 0) {
      // Nothing new — don't penalise as miss.
      return
    }
    observedNew = true

    // Roll the round cursor up to the highest observed turn.
    const maxTurn = Math.max(...records.map(r => r.turn))
    state.roundCursor = Math.max(state.roundCursor, maxTurn)
    const round = state.roundCursor

    // Pull a synthetic ledger snapshot — sidecar doesn't own a PEV
    // ledger so we use an empty one (CR-EIG terms that need ledger
    // history will return zero, which is the correct semantics for
    // pure ccbteam observation).
    const ledger: SharedLedger = createEmptyLedger(0)

    // 1. Exploitability
    const eps = exploitability(records, state.opts.oracleAnchors)
    state.lastEpsilon = eps.eps
    await state.writer.write({
      kind: 'round.exploitability',
      sessionId: state.opts.sessionId,
      round,
      eps: eps.eps,
      perAgent: eps.perAgent,
      timestamp: Date.now(),
    })

    // 2. Gradient ranking — needs a profile shape; we resolve the
    // actual command-layer profile by id. (services → commands is the
    // ALLOWED direction; the forbidden one is commands → math/internals.)
    const profile = getProfileById(state.opts.profileId)
    const ranked = rankGradients({
      records,
      ledger,
      profile,
      weights: state.opts.weights,
      cavMatrix: records.map(r => r.cav),
      oracleAnchors: state.opts.oracleAnchors,
      round,
    })
    const ranking: SerializedRankedGradient[] = ranked.map(serializeRanked)
    await state.writer.write({
      kind: 'round.cr-eig',
      sessionId: state.opts.sessionId,
      round,
      ranking,
      timestamp: Date.now(),
    })

    // Cumulative CR-EIG = sum of the top-1 per round.
    if (ranked.length > 0) {
      state.totalCrEig += ranked[0]!.crEig
      state.toolCallCount += 1
    }

    // 3. α drift snapshot
    const consensus = cavWeightedConsensus(records as CavRecord[])
    if (consensus) {
      state.alphaDrift = consensus.drift
    }

    // 4. Epistemic block parsing per new record
    for (const r of newRecords) {
      const prior = {
        wasFlaggedAsBoundaryViolation: state.flaggedAgents.has(r.agentId),
        agentId: r.agentId,
      }
      const result = parseAndCheckEpistemic(r.claim, prior)
      if (result.verdict === null) {
        await state.writer.write({
          kind: 'degradation',
          sessionId: state.opts.sessionId,
          round,
          reason: 'epistemic-missing',
          details: `agent=${r.agentId} turn=${r.turn} no parseable <epistemic> block`,
          timestamp: Date.now(),
        })
      } else {
        await state.writer.write({
          kind: 'round.epistemic',
          sessionId: state.opts.sessionId,
          round,
          agentId: r.agentId,
          verdict: result.verdict as EpistemicVerdict,
          timestamp: Date.now(),
        })
      }
      // Persist any rule violations
      for (const v of result.violations) {
        await state.writer.write({
          kind: 'round.epistemic-violation',
          sessionId: state.opts.sessionId,
          round,
          agentId: r.agentId,
          ruleId: v.ruleId,
          details: v.details,
          timestamp: Date.now(),
        })
        const arr = state.epistemicViolationsByAgent.get(r.agentId) ?? []
        arr.push(v.ruleId)
        state.epistemicViolationsByAgent.set(r.agentId, arr)
        // Once an agent crosses any rule, mark it for E5 in subsequent rounds.
        state.flaggedAgents.add(r.agentId)
      }
    }
  } catch (err) {
    // Math layer threw — count miss + emit degradation event.
    state.missCount += 1
    try {
      await state.writer.write({
        kind: 'degradation',
        sessionId: state.opts.sessionId,
        reason: 'poll-tick-error',
        details: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      })
    } catch {
      /* swallow */
    }
  }

  // Budget check — exceeded ⇒ also a miss
  const elapsed = Date.now() - t0
  if (observedNew && elapsed > SIDECAR_POLL_BUDGET_MS) {
    state.missCount += 1
  } else if (observedNew) {
    state.missCount = 0
  }

  // 3-strike degrade
  if (state.missCount >= SIDECAR_DEGRADE_AFTER_MISSES && !state.disarmed) {
    state.disarmed = true
    state.endReason = 'sidecar-degraded'
    try {
      await state.writer.write({
        kind: 'degradation',
        sessionId: state.opts.sessionId,
        reason: 'three-strike-disarm',
        details: `polling disarmed after ${state.missCount} consecutive misses`,
        timestamp: Date.now(),
      })
    } catch {
      /* swallow */
    }
  }
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function serializeRanked(r: RankedGradient): SerializedRankedGradient {
  return {
    gradient: r.gradient,
    crEig: r.crEig,
    breakdown: r.breakdown,
    modelChose: r.modelChose,
  }
}

/* -------------------------------------------------------------------------- */
/* renderInformationEfficiencyMarkdown                                        */
/* -------------------------------------------------------------------------- */

function renderInformationEfficiencyMarkdown(state: SidecarState): string {
  const totalCalls = Math.max(1, state.toolCallCount)
  const avgGain = state.totalCrEig / totalCalls
  const causalFraction =
    state.causalInterventionTotal === 0
      ? 0
      : state.causalCausalConfirms / state.causalInterventionTotal

  const lines: string[] = []
  lines.push('')
  lines.push('## Information Efficiency')
  lines.push('')
  lines.push(`- Total CR-EIG observed: ${state.totalCrEig.toFixed(2)} bits`)
  lines.push(
    `- Tool calls: ${state.toolCallCount} | Avg observed gain per call: ${avgGain.toFixed(2)} bits/call`,
  )
  lines.push(
    `- Final ε_t: ${state.lastEpsilon === null ? 'N/A' : state.lastEpsilon.toFixed(2)} (lower = closer to ε-NE)`,
  )
  lines.push(
    `- Causal fraction: ${(causalFraction * 100).toFixed(0)}% (causal-confirm / total interventions)`,
  )
  lines.push(
    `- Trust-weighted α drift: ${state.alphaDrift >= 0 ? '+' : ''}${state.alphaDrift.toFixed(2)} (alphaWeighted − alphaClassical)`,
  )

  // Knowledge boundary violation summary
  lines.push('')
  lines.push('### Knowledge Boundary Violations')
  if (state.epistemicViolationsByAgent.size === 0) {
    lines.push('(none)')
  } else {
    for (const [agentId, rules] of state.epistemicViolationsByAgent) {
      const counts: Record<string, number> = {}
      for (const r of rules) counts[r] = (counts[r] ?? 0) + 1
      const summary = Object.entries(counts)
        .map(([k, v]) => `${k}×${v}`)
        .join(', ')
      lines.push(`- ${agentId}: ${summary}`)
    }
  }

  if (state.endReason === 'sidecar-degraded') {
    lines.push('')
    lines.push(`> Sidecar degradation: ${state.endReason}`)
  }

  return lines.join('\n')
}

// Reference computeCausalConfidence to keep import alive — when we
// hook real intervention evidence in v2 we'll wire it in.
void computeCausalConfidence

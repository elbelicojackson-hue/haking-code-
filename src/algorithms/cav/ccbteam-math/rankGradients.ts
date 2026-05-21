/**
 * T9 — `rankGradients` pure function.
 *
 * Score every ∇H gradient axis via {@link computeCrEig} and return them
 * in CR-EIG-descending order. The 5 ∇H axes are:
 *   - attack       — point a teammate at another's high-entropy claim
 *   - swap         — propose replacing a teammate (suspect collusion)
 *   - oracle       — invoke a profile.oracles channel
 *   - chain        — rotate the dominant compartment role
 *   - discretize   — adjust internal belief clustering granularity
 *
 * Hard rules (audited):
 *   - Pure: same input → same output. No I/O, no Date.now.
 *   - All 5 axes always represented (returned array length === 5).
 *   - Tie-break (R4-3): primary `crEig` desc → historical use count
 *     asc → gradient lex-asc.
 *   - All scoring funnels through `computeCrEig` — no side-channel
 *     scoring loop (R4-4).
 *
 * Cross-references:
 *   - .kiro/specs/super-agent-cluster/requirements.md → R4-1..R4-6
 *   - .kiro/specs/super-agent-cluster/design.md → "Algorithm 3"
 */

import { computeCrEig } from './crEig.js'
import { GRADIENT_IDS, RANK_TIE_TOLERANCE } from './constants.js'
import type {
  Candidate,
  CavRecord,
  CrEigCtx,
  CrEigWeights,
  GradientId,
  Hypothesis,
  OracleAnchor,
  RankedGradient,
  SharedLedger,
  ToolPlan,
} from './types.js'
import { findToolPlan, getToolPlansForKind } from '../pev/canonicalTests.js'

/* -------------------------------------------------------------------------- */
/* rankGradients                                                              */
/* -------------------------------------------------------------------------- */

export type RankGradientsArgs = {
  readonly records: readonly CavRecord[]
  readonly ledger: SharedLedger
  readonly profile: CrEigCtx['profile']
  readonly weights: CrEigWeights
  readonly cavMatrix: readonly CrEigCtx['cavMatrix'][number][]
  readonly oracleAnchors: readonly OracleAnchor[]
  readonly round: number
}

/**
 * Build candidates for one ∇H axis + score them, return only the
 * **best** candidate per axis. Always returns 5 entries (one per
 * gradient). modelChose defaults to `false` — sidecar back-fills it.
 */
export function rankGradients(args: RankGradientsArgs): RankedGradient[] {
  const ranked: RankedGradient[] = []

  for (const gradient of GRADIENT_IDS) {
    const candidates = buildCandidatesForGradient(gradient, args)
    if (candidates.length === 0) {
      // Even when no plan-bearing candidate is constructible, a placeholder
      // candidate with no plan / no hypothesis still goes through computeCrEig
      // so the urgency term contributes.
      candidates.push({ gradientId: gradient })
    }

    let bestCrEig = -Infinity
    let bestBreakdown: RankedGradient['breakdown'] | null = null
    let bestCandidate: Candidate | null = null
    for (const cand of candidates) {
      const result = computeCrEig(cand, {
        ledger: args.ledger,
        cavMatrix: args.cavMatrix,
        profile: args.profile,
        weights: args.weights,
        records: args.records,
        oracleAnchors: args.oracleAnchors,
        round: args.round,
      })
      if (result.crEig > bestCrEig) {
        bestCrEig = result.crEig
        bestBreakdown = result.breakdown
        bestCandidate = cand
      }
    }

    ranked.push({
      gradient,
      crEig: bestCrEig === -Infinity ? 0 : bestCrEig,
      breakdown: bestBreakdown ?? {
        baseEig: 0,
        trustWeightedConfirm: 0,
        trustWeightedFalsify: 0,
        costPenalty: 0,
        causalGain: 0,
        urgencyBoost: 0,
        explorationBonus: 0,
      },
      explanation: formatExplanation(gradient, bestCrEig, bestCandidate),
      modelChose: false,
    })
  }

  // Tie-break: primary crEig desc; secondary historical-use asc;
  // tertiary gradient lex-asc.
  const useCount = countHistoricalGradientUses(args.ledger)
  ranked.sort((a, b) => {
    if (Math.abs(a.crEig - b.crEig) > RANK_TIE_TOLERANCE) {
      return b.crEig - a.crEig
    }
    const ua = useCount[a.gradient] ?? 0
    const ub = useCount[b.gradient] ?? 0
    if (ua !== ub) return ua - ub
    return a.gradient.localeCompare(b.gradient)
  })

  return ranked
}

/* -------------------------------------------------------------------------- */
/* candidate builders                                                         */
/* -------------------------------------------------------------------------- */

function buildCandidatesForGradient(
  gradient: GradientId,
  args: RankGradientsArgs,
): Candidate[] {
  switch (gradient) {
    case 'oracle':
      return buildOracleCandidates(args)
    case 'attack':
      return buildAttackCandidates(args)
    case 'swap':
    case 'chain':
    case 'discretize':
      return [{ gradientId: gradient }]
    default: {
      const _x: never = gradient
      void _x
      return []
    }
  }
}

function buildOracleCandidates(args: RankGradientsArgs): Candidate[] {
  // Pair each oracle channel with the "hottest" hypothesis available
  // (max confidence among open ones). When no oracle/no hypothesis
  // exist, we still return the bare gradientId placeholder so the axis
  // contributes urgencyBoost only.
  const hotH = pickHottestHypothesis(args.ledger)
  const out: Candidate[] = []
  if (args.profile.oracles.length === 0) {
    out.push({
      gradientId: 'oracle',
      hypothesis: hotH ?? undefined,
    })
    return out
  }
  for (const oracleText of args.profile.oracles) {
    // Match an oracle to a plan when possible — heuristic: find any
    // plan whose `kind` matches the hottest hypothesis.
    const plan = hotH ? matchPlanForOracle(oracleText, hotH) : undefined
    out.push({
      gradientId: 'oracle',
      oracleChannel: oracleText,
      hypothesis: hotH ?? undefined,
      plan,
    })
  }
  return out
}

function buildAttackCandidates(args: RankGradientsArgs): Candidate[] {
  // Pick the highest-`self_entropy` peer's latest claim as the attack
  // target. No plan/hypothesis attached — attacks are pure conversational
  // moves, so baseEig=0 / costPenalty=0 / causalGain=0 — only urgency
  // contributes.
  const targets = identifyAttackTargets(args.records)
  if (targets.length === 0) return [{ gradientId: 'attack' }]
  return targets.map(t => ({ gradientId: 'attack' as const, attackTarget: t }))
}

function pickHottestHypothesis(ledger: SharedLedger): Hypothesis | null {
  let best: Hypothesis | null = null
  for (const h of ledger.hypotheses.values()) {
    if (h.status !== 'open' && h.status !== 'evidence') continue
    if (!best || h.confidence > best.confidence) best = h
  }
  return best
}

function matchPlanForOracle(_oracle: string, h: Hypothesis): ToolPlan | undefined {
  const plans = getToolPlansForKind(h.kind)
  if (plans.length === 0) return undefined
  // v1: pick the cheapest plan for the kind. Improves later by parsing
  // `oracle` text against plan tool name.
  return plans.reduce((acc, p) => {
    if (!acc) return p
    return rankCost(p) < rankCost(acc) ? p : acc
  }, plans[0])
}

function rankCost(p: ToolPlan): number {
  return { tiny: 0, small: 1, medium: 2, large: 3 }[p.cost_estimate] ?? 4
}

function identifyAttackTargets(
  records: readonly CavRecord[],
): { targetAgentId: string; targetClaimDigest: string }[] {
  const byAgent = new Map<string, CavRecord>()
  for (const r of records) {
    const prev = byAgent.get(r.agentId)
    if (!prev || r.turn >= prev.turn) byAgent.set(r.agentId, r)
  }
  const arr = Array.from(byAgent.values())
  arr.sort((a, b) => {
    const ea = a.cav.self_entropy ?? 0.5
    const eb = b.cav.self_entropy ?? 0.5
    return eb - ea
  })
  // Top 3 highest-entropy peers.
  return arr.slice(0, 3).map(r => ({
    targetAgentId: r.agentId,
    targetClaimDigest: r.claim.slice(0, 80),
  }))
}

/**
 * Count how many evidenceLog entries map to each ∇H gradient. v1
 * heuristic: classify by the plan id prefix or tool name. Used only for
 * the secondary tie-break (R4-3); inaccuracy is acceptable.
 */
function countHistoricalGradientUses(
  ledger: SharedLedger,
): Record<GradientId, number> {
  const counts: Record<GradientId, number> = {
    attack: 0,
    chain: 0,
    discretize: 0,
    oracle: 0,
    swap: 0,
  }
  for (const ev of ledger.evidenceLog) {
    const planId = ev.planId ?? ''
    const plan = planId ? findToolPlan(planId) : undefined
    if (plan) counts.oracle += 1
  }
  return counts
}

/* -------------------------------------------------------------------------- */
/* explanation                                                                */
/* -------------------------------------------------------------------------- */

function formatExplanation(
  gradient: GradientId,
  crEig: number,
  candidate: Candidate | null,
): string {
  const score = Number.isFinite(crEig) ? crEig.toFixed(3) : '0.000'
  const planLabel = candidate?.plan ? ` plan=${candidate.plan.id}` : ''
  const oracleLabel = candidate?.oracleChannel
    ? ` oracle=${candidate.oracleChannel.slice(0, 32)}`
    : ''
  const text = `∇H_${gradient}: CR-EIG=${score}${planLabel}${oracleLabel}`
  return text.length <= 200 ? text : text.slice(0, 197) + '...'
}

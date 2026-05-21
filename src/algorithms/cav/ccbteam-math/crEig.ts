/**
 * T7 — `computeCrEig` main algorithm.
 *
 * Algorithm 1 (design.md), 7 steps:
 *   1. baseEig   — Bayesian information gain via existing PEV `binaryEntropy`
 *                  + `planStats` + `cavAdaptiveDelta` (R2)
 *   2. trust     — w̄_t · (α · ΔH_confirm + β · ΔH_falsify)
 *   3. cost      — −λ_cost · costInBits(plan)
 *   4. causal    — γ_caus · φ_j · (1 − corr_j)         (R7-3 safe degrade)
 *   5. urgency   — κ · (1 − ρ_t)                       (R3-3 connection)
 *   6. explore   — γ_explore · explorationBonus        (PEV reuse)
 *   7. crEig     — sum of 1..6, returned with breakdown
 *
 * Hard rules:
 *   - Pure (R1-7): no I/O, no Date.now, no random, no file reads.
 *   - 7 fields in breakdown ALWAYS present (R1-3).
 *   - Default-weight envelope: crEig ∈ [−0.05, 1.35] (R7-2).
 *   - cavMatrix empty → trustWeight 退化为 1.0 (R1-4).
 *   - Plan history all-correlation-only → causalGain = 0 (R7-3).
 *
 * Cross-references:
 *   - .kiro/specs/super-agent-cluster/requirements.md → R1, R6, R7
 *   - .kiro/specs/super-agent-cluster/design.md → "Algorithm 1"
 */

import { trustWeight } from '../analyzer.js'
import { binaryEntropy, computeExplorationBonus } from '../pev/eigEngine.js'
import {
  applyCausalBoost,
  supportsCausalInference,
} from '../pev/causalEngine.js'
import { computePlanStats } from '../pev/planStats.js'
import { ADAPTIVE_DELTA_EPS_FLOOR, PROB_CLAMP_MAX, PROB_CLAMP_MIN } from './constants.js'
import { cavAdaptiveDelta } from './delta.js'
import { costInBits } from './cost.js'
import { consensusUrgency } from './urgency.js'
import type { Candidate, CavReading, CrEigCtx, CrEigResult } from './types.js'

/* -------------------------------------------------------------------------- */
/* computeCrEig                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Score one candidate. Always returns a fully-populated breakdown.
 *
 * `causalGain` uses {@link applyCausalBoost} from the existing PEV
 * causal engine, weighted by `weights.gammaCausal`. The boost itself
 * contributes a multiplicative ≤ 1.5 factor on the baseline EIG; we
 * subtract the baseline before scaling by gammaCausal so the dimensional
 * envelope in R7-2 is preserved.
 */
export function computeCrEig(
  candidate: Candidate,
  ctx: CrEigCtx,
): CrEigResult {
  const { ledger, cavMatrix, weights, records, oracleAnchors, round } = ctx
  const hasPlan = !!candidate.plan
  const hasHypothesis = !!candidate.hypothesis

  /* --- Step 1: baseEig (Bayesian outcome-conditioned entropy drop) --- */

  let baseEig = 0
  let priorH = 0
  let pConfirm = 0.5
  let pFalsify = 0.5
  let alpha = 0
  let beta = 0
  if (hasPlan && hasHypothesis) {
    const plan = candidate.plan!
    const h = candidate.hypothesis!
    const p = clamp(h.confidence, PROB_CLAMP_MIN, PROB_CLAMP_MAX)
    priorH = binaryEntropy(p)

    // CAV-adaptive δ (R2)
    let delta: number
    if (weights.useAdaptiveDelta) {
      const lastReading = pickLastNonNullReading(cavMatrix)
      delta = lastReading
        ? cavAdaptiveDelta(lastReading, { deltaZero: weights.deltaZero })
        : weights.deltaZero
    } else {
      delta = weights.deltaZero
    }

    const stats = computePlanStats(plan.id, ledger)
    alpha = stats.confirmRate
    beta = stats.falsifyRate
    const gamma = stats.inconclusiveRate

    pConfirm = clamp(p + delta * (1 - p), PROB_CLAMP_MIN, PROB_CLAMP_MAX)
    pFalsify = clamp(p - delta * p, PROB_CLAMP_MIN, PROB_CLAMP_MAX)
    const expectedH =
      alpha * binaryEntropy(pConfirm) +
      beta * binaryEntropy(pFalsify) +
      gamma * priorH

    baseEig = Math.max(0, priorH - expectedH)
  }

  /* --- Step 2: trust-weighted confirm/falsify gains --- */

  let wBar = 1
  if (cavMatrix.length > 0) {
    const wSum = cavMatrix.reduce((s, c) => s + trustWeight(c), 0)
    wBar = wSum / cavMatrix.length
  }

  const gainConfirm = priorH - binaryEntropy(pConfirm)
  const gainFalsify = priorH - binaryEntropy(pFalsify)
  const trustWeightedConfirm = hasPlan && hasHypothesis ? wBar * alpha * gainConfirm : 0
  const trustWeightedFalsify = hasPlan && hasHypothesis ? wBar * beta * gainFalsify : 0

  /* --- Step 3: cost penalty --- */

  const costPenalty = hasPlan
    ? weights.lambdaCost * costInBits(candidate.plan!)
    : 0

  /* --- Step 4: causal gain (R7-3 safe degrade) --- */

  let causalGain = 0
  if (hasPlan && supportsCausalInference(candidate.plan!.id)) {
    // Re-derive the causal multiplier from applyCausalBoost: it returns
    // baseEig × multiplier where multiplier ∈ [1.0, 1.5]. We extract the
    // pure delta and re-weight by gammaCausal to keep the term inside
    // the R7-2 envelope.
    const boosted = applyCausalBoost(baseEig, candidate.plan!.id, ledger)
    const causalDelta = boosted - baseEig // ∈ [0, 0.5 × baseEig]
    causalGain = weights.gammaCausal * causalDelta
  }

  /* --- Step 5: urgency boost --- */

  const urgency = consensusUrgency(records, oracleAnchors)
  const urgencyBoost = weights.kappaUrgency * (1 - urgency.rho)

  /* --- Step 6: exploration bonus --- */

  let explorationBonus = 0
  if (hasPlan && hasHypothesis) {
    explorationBonus = computeExplorationBonus(
      candidate.hypothesis!,
      candidate.plan!,
      ledger,
      weights.gammaExplore,
    )
  }

  // R4-6: cold-start oracle bonus on `generic` profile, round < 2.
  if (
    candidate.gradientId === 'oracle' &&
    ctx.profile.id === 'generic' &&
    round < 2
  ) {
    explorationBonus += 0.1
  }

  /* --- Step 7: sum --- */

  const crEig =
    trustWeightedConfirm +
    trustWeightedFalsify -
    costPenalty +
    causalGain +
    urgencyBoost +
    explorationBonus

  return {
    crEig,
    breakdown: {
      baseEig,
      trustWeightedConfirm,
      trustWeightedFalsify,
      costPenalty,
      causalGain,
      urgencyBoost,
      explorationBonus,
    },
  }
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x))
}

function pickLastNonNullReading(
  cavMatrix: readonly CavReading[],
): CavReading | null {
  // Iterate in reverse to pick most-recent non-null strong-signal reading.
  for (let i = cavMatrix.length - 1; i >= 0; i--) {
    const r = cavMatrix[i]
    if (r && r.self_entropy !== null && r.calibration !== null) return r
  }
  // Fall back to last reading even if strong signals are null — `delta`
  // will see them and fall back to deltaZero internally (R2-3).
  return cavMatrix.length > 0 ? cavMatrix[cavMatrix.length - 1]! : null
}

// Re-export ADAPTIVE_DELTA_EPS_FLOOR so test files can reference the same
// floor as the runtime — design.md → "Pinned Constant 10 / Algorithm 1".
export { ADAPTIVE_DELTA_EPS_FLOOR }

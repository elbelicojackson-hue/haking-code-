/**
 * EIG Engine — Expected Information Gain computation for optimal
 * experiment design in the PEV scheduler.
 *
 * Core insight: the most valuable tool call is not the one targeting
 * the highest-confidence hypothesis, but the one whose result —
 * regardless of outcome — maximally reduces the total uncertainty
 * (entropy) of the hypothesis set.
 *
 * Mathematical basis: Shannon binary entropy + Bayesian posterior update.
 *
 * Hard rules:
 *   - Pure function: same inputs → same outputs. No I/O, no randomness.
 *   - EIG ∈ [0, 1] bits for binary hypotheses.
 *   - Performance: ≤ 1ms per (H, plan) pair.
 *
 * Cross-references:
 *   - .kiro/specs/pev-eig-scheduler/design.md → Core Algorithm
 *   - .kiro/specs/pev-eig-scheduler/requirements.md → R1, R3
 */

import type { Hypothesis, SharedLedger } from './ledger.js'
import type { ToolPlan } from './canonicalTests.js'
import { computePlanStats, type PlanStats } from './planStats.js'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type EIGBreakdown = {
  readonly priorEntropy: number
  readonly expectedPosteriorEntropy: number
  readonly confirmProb: number
  readonly falsifyProb: number
  readonly inconclusiveProb: number
  readonly posteriorIfConfirm: number
  readonly posteriorIfFalsify: number
}

export type EIGResult = {
  readonly eig: number
  readonly breakdown: EIGBreakdown
}

export type EIGCandidate = {
  readonly hypothesis: Hypothesis
  readonly plan: ToolPlan
  readonly eig: number
  readonly explorationBonus: number
  readonly total: number // eig + explorationBonus
  readonly breakdown: EIGBreakdown
}

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Clamp bounds to avoid log(0). */
const P_MIN = 0.001
const P_MAX = 0.999

/** Bayesian update step size (v1 empirical value). */
const DELTA_SCALE = 0.2

/** Default exploration weight. */
export const DEFAULT_EXPLORATION_WEIGHT = 0.1

/* -------------------------------------------------------------------------- */
/* Core functions                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Multinomial (Shannon) entropy H(p₁, p₂, ..., pₖ) = -Σ pᵢ·log₂(pᵢ).
 *
 * The k-ary generalisation of Shannon entropy. When the input has
 * exactly 2 complementary elements `[p, 1-p]`, this degenerates to the
 * classic binary entropy.
 *
 * Edge cases:
 *   - empty array → 0 (no uncertainty over an empty event space)
 *   - any pᵢ ≤ 0 → contribution skipped (0·log₂(0) = 0 by convention)
 *   - any pᵢ ≥ 1 → contribution skipped (1·log₂(1) = 0)
 *   - input is NOT required to sum to 1; mass below 1 is treated as
 *     "missing probability" (no contribution). This makes the function
 *     robust against rounding without forcing callers to renormalise.
 *
 * Used by:
 *   - {@link binaryEntropy} delegates here for the 2-class case
 *   - future multi-class hypothesis support (k-ary protocol classes,
 *     family disambiguation across N candidates, etc.)
 *
 * @param probs  Array of probabilities (≥ 0, ≤ 1 each).
 * @returns      Entropy in bits, always ≥ 0.
 */
export function multinomialEntropy(probs: readonly number[]): number {
  if (probs.length === 0) return 0
  let entropy = 0
  for (const p of probs) {
    if (p <= 0) continue
    if (p >= 1) continue // single certainty → zero entropy contribution from others
    entropy -= p * Math.log2(p)
  }
  return Math.max(0, entropy)
}

/**
 * Binary entropy H(p) = -p·log₂(p) - (1-p)·log₂(1-p).
 *
 * Thin shim over {@link multinomialEntropy} fixed at the 2-class case
 * `[p, 1-p]`. Returns 0 for p ≤ 0 or p ≥ 1 (certainty = zero entropy).
 *
 * Why a delegate rather than the closed-form expression: keeping
 * `multinomialEntropy` on the hot path means the same code that handles
 * k-ary protocol-class disambiguation also handles binary packed/unpacked
 * verdicts, so we have ONE entropy implementation to test and trust.
 */
export function binaryEntropy(p: number): number {
  if (p <= 0 || p >= 1) return 0
  return multinomialEntropy([p, 1 - p])
}

/**
 * Compute the Expected Information Gain for a (hypothesis, plan) pair.
 *
 * @param hypothesis  The hypothesis to potentially test
 * @param plan        The tool plan to potentially run
 * @param ledger      Current ledger (for plan stats lookup)
 * @param priors      Optional override for plan hit rates (testing)
 */
export function computeEIG(
  hypothesis: Hypothesis,
  plan: ToolPlan,
  ledger: SharedLedger,
  priors?: PlanStats,
): EIGResult {
  // Current prior = hypothesis confidence, clamped
  const p = clamp(hypothesis.confidence, P_MIN, P_MAX)

  // Prior entropy
  const priorEntropy = binaryEntropy(p)

  // Plan likelihood estimates
  const stats = priors ?? computePlanStats(plan.id, ledger)
  const α = stats.confirmRate   // P(confirm | plan)
  const β = stats.falsifyRate   // P(falsify | plan)
  const γ = stats.inconclusiveRate // P(inconclusive | plan)

  // Posterior after each outcome (simplified Bayesian step)
  const deltaConfirm = DELTA_SCALE * (1 - p)
  const deltaFalsify = DELTA_SCALE * p

  const posteriorIfConfirm = clamp(p + deltaConfirm, P_MIN, P_MAX)
  const posteriorIfFalsify = clamp(p - deltaFalsify, P_MIN, P_MAX)

  // Expected posterior entropy
  const expectedPosteriorEntropy =
    α * binaryEntropy(posteriorIfConfirm) +
    β * binaryEntropy(posteriorIfFalsify) +
    γ * binaryEntropy(p) // inconclusive doesn't change belief

  // EIG = entropy reduction
  const eig = Math.max(0, priorEntropy - expectedPosteriorEntropy)

  return {
    eig,
    breakdown: {
      priorEntropy,
      expectedPosteriorEntropy,
      confirmProb: α,
      falsifyProb: β,
      inconclusiveProb: γ,
      posteriorIfConfirm,
      posteriorIfFalsify,
    },
  }
}

/**
 * Compute the exploration bonus for a (hypothesis, plan) pair.
 * Encourages testing untried combinations.
 *
 * Formula: weight * (1 - timesTestedRatio)
 * where timesTestedRatio = times this H has been tested / total plans for its kind
 */
export function computeExplorationBonus(
  hypothesis: Hypothesis,
  plan: ToolPlan,
  ledger: SharedLedger,
  weight: number = DEFAULT_EXPLORATION_WEIGHT,
): number {
  // Check if this specific (H, plan.tool) combination was already tested
  const alreadyTested = ledger.evidenceLog.some(
    ev => ev.testedHypothesis === hypothesis.id && ev.toolName === plan.tool,
  )
  if (alreadyTested) return 0

  // Count how many distinct tools have tested this hypothesis
  const testedTools = new Set<string>()
  for (const ev of ledger.evidenceLog) {
    if (ev.testedHypothesis === hypothesis.id) {
      testedTools.add(ev.toolName)
    }
  }

  // Ratio of tested tools to available plans for this kind
  // (import would create circular dep; use a simple heuristic: assume 3 plans per kind)
  const totalPlansForKind = 3 // conservative estimate
  const ratio = Math.min(1, testedTools.size / totalPlansForKind)

  return weight * (1 - ratio)
}

/**
 * Rank a list of EIG candidates by total score (EIG + bonus) descending.
 * Tie-break: cost_estimate ascending, then hypothesis id ascending.
 */
export function rankCandidates(candidates: readonly EIGCandidate[]): EIGCandidate[] {
  const costOrder: Record<string, number> = {
    tiny: 0,
    small: 1,
    medium: 2,
    large: 3,
  }

  return [...candidates].sort((a, b) => {
    // Primary: total score descending
    if (b.total !== a.total) return b.total - a.total
    // Secondary: cost ascending
    const costA = costOrder[a.plan.cost_estimate] ?? 2
    const costB = costOrder[b.plan.cost_estimate] ?? 2
    if (costA !== costB) return costA - costB
    // Tertiary: hypothesis id ascending
    return a.hypothesis.id.localeCompare(b.hypothesis.id)
  })
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x))
}

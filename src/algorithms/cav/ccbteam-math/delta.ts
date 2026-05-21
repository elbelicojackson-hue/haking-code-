/**
 * T8 — `cavAdaptiveDelta` pure function.
 *
 * Replaces the constant `DELTA_SCALE = 0.2` step in `eigEngine.ts` with
 * a CAV-self-aware variant:
 *
 *     δ_t = δ_0 · w(reading) · (1 − reading.self_entropy)
 *
 * where `w` is `analyzer.trustWeight`. Trustworthy + low-entropy agents
 * get larger Bayesian updates; uncertain or untrusted agents get smaller
 * ones — concentrating the EIG signal on the agents who actually carry
 * information.
 *
 * Hard rules:
 *   - Pure function: same reading → same δ. No I/O, no Date.now().
 *   - Strong-signal fallback: when `self_entropy === null` OR
 *     `calibration === null`, we cannot compute the adaptive form, so
 *     return `deltaZero` (matches legacy `eigEngine` behaviour bit-for-
 *     bit — R2-3 / R2-7 contract).
 *   - δ ∈ (0, deltaZero] strictly: each multiplier is floored at
 *     {@link ADAPTIVE_DELTA_EPS_FLOOR} to keep the result strictly
 *     positive (R2-4).
 *
 * Cross-references:
 *   - .kiro/specs/super-agent-cluster/requirements.md → R2-1..R2-6
 *   - .kiro/specs/super-agent-cluster/design.md → "Algorithm 1 step 1
 *     internal δ"
 */

import { trustWeight } from '../analyzer.js'
import { ADAPTIVE_DELTA_EPS_FLOOR, DEFAULT_CR_EIG_WEIGHTS } from './constants.js'
import type { CavReading } from './types.js'

/**
 * Compute the CAV-adaptive Bayesian step for one teammate reading.
 *
 * @param reading — single CAV reading from the agent's most-recent turn.
 * @param opts.deltaZero — baseline step; defaults to 0.2 (matches the
 *                          legacy `DELTA_SCALE` constant in eigEngine).
 * @returns δ_t ∈ (0, deltaZero] when strong signals are present;
 *          `deltaZero` exactly when they are missing.
 */
export function cavAdaptiveDelta(
  reading: CavReading,
  opts?: { deltaZero?: number },
): number {
  const deltaZero = opts?.deltaZero ?? DEFAULT_CR_EIG_WEIGHTS.deltaZero

  // R2-3: strong-signal absence → constant fallback (legacy parity).
  if (reading.self_entropy === null || reading.calibration === null) {
    return deltaZero
  }

  // Two multiplicative factors, each floored to keep δ strictly > 0.
  // R2-4: 0 < δ ≤ deltaZero.
  const trustFactor = clampMin(trustWeight(reading), ADAPTIVE_DELTA_EPS_FLOOR)
  const oneMinusEntropy = clampMin(
    1 - reading.self_entropy,
    ADAPTIVE_DELTA_EPS_FLOOR,
  )

  const result = deltaZero * trustFactor * oneMinusEntropy

  // Clamp to [floor, deltaZero] to absorb any numeric drift; the upper
  // bound naturally holds when both factors are ≤ 1, but pin it anyway
  // because `trustWeight` returns 0..1 only by convention not by type.
  return Math.min(deltaZero, Math.max(ADAPTIVE_DELTA_EPS_FLOOR, result))
}

function clampMin(x: number, floor: number): number {
  return x < floor ? floor : x
}

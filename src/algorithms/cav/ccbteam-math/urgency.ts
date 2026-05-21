/**
 * T6 — `consensusUrgency` ρ_t algorithm.
 *
 * Pure observer translation of the 4-quadrant `analyzer.classifyConsensus`
 * into a continuous `ρ_t = 1 − ε_t / EPS_MAX` value, with the original
 * discrete classification surfaced as `state` for backward compatibility.
 *
 * Hard rules (audited):
 *   - Pure: same input → same output. No I/O, no Date.now().
 *   - `rho ∈ [0, 1]`; with `EPS_MAX = 1.0`, `rho + eps === 1` exactly.
 *   - `state` MUST equal `analyzer.classifyConsensus(records)` bit-for-
 *     bit (R3-5 zero regression).
 *   - Empty records → `{ rho: 0, state: 'NONE', ... }` (R3-6).
 *
 * Cross-references:
 *   - .kiro/specs/super-agent-cluster/requirements.md → R3-3..R3-7
 *   - .kiro/specs/super-agent-cluster/design.md → "Pinned Constant 3"
 */

import { classifyConsensus } from '../analyzer.js'
import { EPS_MAX } from './constants.js'
import { exploitability } from './exploitability.js'
import type {
  CavRecord,
  ConsensusUrgencyResult,
  OracleAnchor,
} from './types.js'

const MIN_SAMPLES_FOR_MI = 5

/**
 * Compute the continuous consensus urgency `ρ_t = 1 − ε_t / EPS_MAX`.
 *
 * @param records       — current CAV record stream
 * @param oracleAnchors — oracle anchors derived from `profile.oracles`
 * @returns `{ rho, state, components, eps }` per design.md.
 */
export function consensusUrgency(
  records: readonly CavRecord[],
  oracleAnchors: readonly OracleAnchor[],
): ConsensusUrgencyResult {
  // Zero-record fallback: total uncertainty → urgency rho=0.
  if (records.length === 0) {
    return {
      rho: 0,
      state: 'NONE',
      components: {
        maxBestResponseGain: EPS_MAX,
        miSampleSufficient: false,
        oracleAvailable: oracleAnchors.length > 0,
      },
      eps: EPS_MAX,
    }
  }

  // Compute ε_t via exploitability (T5).
  const eps = exploitability(records, oracleAnchors)

  // Continuous urgency. EPS_MAX = 1.0 ⇒ rho + eps === 1.
  const rho = clamp01(1 - eps.eps / EPS_MAX)

  // Discrete state — pass through analyzer.classifyConsensus, mutating
  // the array shape only via `as` because classifyConsensus expects
  // mutable. We do not modify it.
  const state = classifyConsensus(records as CavRecord[])

  return {
    rho,
    state,
    components: {
      maxBestResponseGain: eps.eps,
      miSampleSufficient: records.length >= MIN_SAMPLES_FOR_MI,
      oracleAvailable: oracleAnchors.length > 0,
    },
    eps: eps.eps,
  }
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

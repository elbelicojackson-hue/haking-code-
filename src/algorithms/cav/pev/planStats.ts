/**
 * Plan Statistics — pure-function aggregator over the evidence log.
 *
 * Computes per-plan confirm/falsify/inconclusive rates from the live
 * ledger. These rates serve as the likelihood estimates for the EIG
 * computation in `eigEngine.ts`.
 *
 * Hard rules:
 *   - Pure function: same ledger → same output. No I/O, no Date.now().
 *   - Laplace smoothing when sampleCount < 3 (prevents 0/1 extremes
 *     that would make EIG degenerate).
 *   - Uniform prior (0.4/0.4/0.2) when no evidence exists for a plan.
 *
 * Cross-references:
 *   - .kiro/specs/pev-eig-scheduler/design.md → Plan Stats Aggregation
 *   - .kiro/specs/pev-eig-scheduler/requirements.md → R4
 */

import { findToolPlan } from './canonicalTests.js'
import type { SharedLedger } from './ledger.js'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type PlanStats = {
  readonly confirmRate: number
  readonly falsifyRate: number
  readonly inconclusiveRate: number
  readonly sampleCount: number
}

/** Default prior when no evidence exists for a plan. */
const UNIFORM_PRIOR: PlanStats = {
  confirmRate: 0.4,
  falsifyRate: 0.4,
  inconclusiveRate: 0.2,
  sampleCount: 0,
} as const

/** Laplace pseudocount threshold — apply smoothing below this. */
const SMOOTHING_THRESHOLD = 3

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Compute the confirm/falsify/inconclusive rates for a given plan id
 * from the current session's evidence log.
 *
 * Matching logic: we look up the plan's `tool` field and count all
 * evidence entries whose `toolName` matches. This mirrors the
 * scheduler's existing "tested by tool" deduplication logic.
 *
 * @param planId  Canonical plan id (e.g. 'packer::diec')
 * @param ledger  Current ledger snapshot (read-only)
 */
export function computePlanStats(
  planId: string,
  ledger: SharedLedger,
): PlanStats {
  const plan = findToolPlan(planId)
  if (!plan) return UNIFORM_PRIOR

  let confirms = 0
  let falsifies = 0
  let inconclusives = 0

  for (const ev of ledger.evidenceLog) {
    if (ev.toolName !== plan.tool) continue
    switch (ev.verdict) {
      case 'confirms':
        confirms += 1
        break
      case 'falsifies':
        falsifies += 1
        break
      default:
        // 'mutates' and 'inconclusive' both count as inconclusive
        // for the purpose of EIG likelihood estimation.
        inconclusives += 1
        break
    }
  }

  const rawTotal = confirms + falsifies + inconclusives

  if (rawTotal === 0) return UNIFORM_PRIOR

  // Laplace smoothing for small samples (R4-5)
  if (rawTotal < SMOOTHING_THRESHOLD) {
    confirms += 1
    falsifies += 1
    inconclusives += 0.5
  }

  const total = confirms + falsifies + inconclusives

  return {
    confirmRate: confirms / total,
    falsifyRate: falsifies / total,
    inconclusiveRate: inconclusives / total,
    sampleCount: rawTotal,
  }
}

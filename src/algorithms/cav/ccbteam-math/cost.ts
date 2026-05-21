/**
 * T3 — `costInBits` pure function.
 *
 * Maps a {@link ToolPlan.cost_estimate} bucket to the bit-units cost
 * penalty consumed by `crEig.computeCrEig` (Algorithm 1, step 3).
 *
 * Hard rules (audited):
 *   - Pure: same input → same output, no I/O, no Date.now(), no random.
 *   - Fail-loud: an unknown `cost_estimate` value (e.g. via an `as` cast
 *     bypass) throws `Error('Unknown cost_estimate: <value>')`. We do
 *     **not** silently degrade to a default — design.md "Constant 1"
 *     enumerates all four buckets and the type system enforces it; any
 *     mismatch indicates a bug worth surfacing.
 *
 * Cross-references:
 *   - .kiro/specs/super-agent-cluster/requirements.md → R6-2
 *   - .kiro/specs/super-agent-cluster/design.md → "Pinned Constant 1" /
 *     "Algorithm 1 step 3"
 */

import { COST_IN_BITS_TABLE } from './constants.js'
import type { ToolPlan } from './types.js'

/**
 * Look up the bit-units cost of a {@link ToolPlan} via its
 * `cost_estimate` bucket.
 *
 * @param plan — the canonical plan whose `cost_estimate` is one of
 *               `'tiny' | 'small' | 'medium' | 'large'`.
 * @throws Error when `plan.cost_estimate` is not one of the four
 *         buckets (defence in depth — TS already prevents this in
 *         well-typed callers).
 */
export function costInBits(plan: ToolPlan): number {
  const value = COST_IN_BITS_TABLE[plan.cost_estimate]
  if (typeof value !== 'number') {
    throw new Error(`Unknown cost_estimate: ${String(plan.cost_estimate)}`)
  }
  return value
}

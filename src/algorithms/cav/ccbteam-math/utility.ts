/**
 * T4 — `estimateUtility` + `bowCos` pure functions.
 *
 * Computes the counterfactual utility `u_i(strategy, others, anchors)`
 * of a single teammate adopting a given `repair_style`. Used by T5
 * `exploitability` to derive ε_t = max_i (best_response_gain_i).
 *
 * Hard rules (audited):
 *   - Pure: same input → same output. No I/O, no Date.now(), no random.
 *   - Output ∈ [0, 1] (convex combination of [0,1] inputs + bounded
 *     STRATEGY_ADJUSTMENT, then clamped).
 *   - 5 strategies must yield strictly distinct utilities (otherwise
 *     ε_t collapses to 0). The STRATEGY_ADJUSTMENT_TABLE breaks the
 *     symmetry — see design.md "Pinned Constant 2".
 *   - `bowCos` is a local copy of the `analyzer.ts` helper; we avoid
 *     re-exporting that function to keep this module dependency-free
 *     of CAV analyzer internals (R5-3 layering).
 *
 * Performance:
 *   - The 1-shot `estimateUtility(args)` API tokenises everything fresh
 *     each call. Hot paths (T5 exploitability) call
 *     {@link buildUtilityCtx} once + {@link estimateUtilityCached} 5×n_agents
 *     times to reuse the pre-tokenised vectors (R3-7 ≤ 5ms budget).
 *
 * Cross-references:
 *   - .kiro/specs/super-agent-cluster/requirements.md → R3-6
 *   - .kiro/specs/super-agent-cluster/design.md → "Pinned Constant 2"
 */

import {
  STRATEGY_ADJUSTMENT_TABLE,
  UTILITY_WEIGHTS,
  W_BELIEF_NO_ORACLE,
  W_GROUP_NO_ORACLE,
} from './constants.js'
import type {
  CavRecord,
  OracleAnchor,
  RepairStyle,
} from './types.js'

/* -------------------------------------------------------------------------- */
/* BoW vector — pre-tokenised representation                                  */
/* -------------------------------------------------------------------------- */

/**
 * Pre-tokenised bag-of-words vector. Created once per claim string and
 * reused across many cosine comparisons in the same `exploitability`
 * call. Empty input ⇒ `freq.size === 0` and `norm === 0` (sentinel
 * returns 0 from {@link bowCosVec}).
 */
export type BowVector = {
  readonly freq: Map<string, number>
  readonly norm: number
}

/** Tokenise + count + L2 norm in one pass. */
export function bowVectorize(s: string): BowVector {
  const freq = new Map<string, number>()
  if (!s) return { freq, norm: 0 }
  const tokens = s
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter(t => t.length > 1)
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1)
  let n2 = 0
  for (const v of freq.values()) n2 += v * v
  return { freq, norm: Math.sqrt(n2) }
}

/** Cosine similarity over pre-tokenised vectors. */
export function bowCosVec(a: BowVector, b: BowVector): number {
  if (a.freq.size === 0 || b.freq.size === 0) return 0
  if (a.norm === 0 || b.norm === 0) return 0
  // Iterate the smaller map for cache friendliness.
  let small = a.freq
  let big = b.freq
  if (a.freq.size > b.freq.size) {
    small = b.freq
    big = a.freq
  }
  let dot = 0
  for (const [k, v] of small) {
    const w = big.get(k)
    if (w) dot += v * w
  }
  return dot / (a.norm * b.norm)
}

/* -------------------------------------------------------------------------- */
/* bowCos — backward-compat string-based wrapper (T4 public API)              */
/* -------------------------------------------------------------------------- */

/**
 * Bag-of-words cosine similarity between two short strings, 0..1.
 *
 * Same algorithm as `cav/analyzer.ts.bowCos` and `cav/extractor.ts`'s
 * cosine fallback. Implemented on top of {@link bowVectorize} so the
 * fast path and the simple path share semantics by construction.
 */
export function bowCos(a: string, b: string): number {
  return bowCosVec(bowVectorize(a), bowVectorize(b))
}

/* -------------------------------------------------------------------------- */
/* UtilityCtx — cached fixture for exploitability hot-path                    */
/* -------------------------------------------------------------------------- */

/**
 * Pre-computed per-agent + per-anchor BoW vectors. Built once per
 * `exploitability` call and threaded through {@link estimateUtilityCached}
 * for the 5×n_agents counterfactual sweep.
 */
export type UtilityCtx = {
  /** Last claim per agent → its BowVector (and original record). */
  readonly latestByAgent: ReadonlyMap<string, { record: CavRecord; vec: BowVector }>
  /** Anchor BoW vectors. */
  readonly anchorVectors: readonly BowVector[]
}

/**
 * Build a UtilityCtx from records + anchors. Pure function;
 * `latestByAgent` keeps insertion order so deterministic iteration
 * holds across the entire pipeline.
 */
export function buildUtilityCtx(
  records: readonly CavRecord[],
  oracleAnchors: readonly OracleAnchor[],
): UtilityCtx {
  // Track most-recent record per agent; assume input is in arrival
  // order and `turn` is monotone non-decreasing per agent (observer.ts
  // contract). Last-write wins on identical turn for the same agent.
  const latest = new Map<string, CavRecord>()
  for (const r of records) {
    const prev = latest.get(r.agentId)
    if (!prev || r.turn >= prev.turn) latest.set(r.agentId, r)
  }
  const latestByAgent = new Map<string, { record: CavRecord; vec: BowVector }>()
  for (const [id, rec] of latest) {
    latestByAgent.set(id, { record: rec, vec: bowVectorize(rec.claim) })
  }
  const anchorVectors = oracleAnchors.map(a => bowVectorize(a.referenceText))
  return { latestByAgent, anchorVectors }
}

/* -------------------------------------------------------------------------- */
/* estimateUtilityCached — fast path                                          */
/* -------------------------------------------------------------------------- */

/**
 * Fast path used by {@link exploitability}. Same semantics as
 * {@link estimateUtility} but consumes a pre-built {@link UtilityCtx}.
 *
 * Group alignment is computed against the **other agents' latest
 * claims** (not against every record) — this matches the design.md
 * "snapshot alignment" interpretation.
 */
export function estimateUtilityCached(args: {
  agentId: string
  strategy: RepairStyle
  ctx: UtilityCtx
  hasAnchors: boolean
}): number {
  const { agentId, strategy, ctx, hasAnchors } = args

  // --- own ---
  const own = ctx.latestByAgent.get(agentId)

  // --- belief_consistency = 1 − update_kl/2 ---
  let beliefConsistency = 0.5
  if (own) {
    const kl = own.record.cav.update_kl
    if (kl !== null && Number.isFinite(kl)) {
      beliefConsistency = clamp01(1 - kl / 2)
    }
  }

  // --- group_alignment: avg cosine over other agents' latest vectors ---
  let groupAlignment = 0.5
  if (own && own.vec.freq.size > 0 && ctx.latestByAgent.size > 1) {
    let sum = 0
    let n = 0
    for (const [id, peer] of ctx.latestByAgent) {
      if (id === agentId) continue
      sum += bowCosVec(own.vec, peer.vec)
      n += 1
    }
    if (n > 0) groupAlignment = clamp01(sum / n)
  }

  // --- oracle_match: max cosine over anchors ---
  let oracleMatch = 0
  if (hasAnchors && ctx.anchorVectors.length > 0 && own && own.vec.freq.size > 0) {
    let best = 0
    for (const av of ctx.anchorVectors) {
      const score = bowCosVec(own.vec, av)
      if (score > best) best = score
    }
    oracleMatch = clamp01(best)
  }

  // --- strategy nudge ---
  const styleAdjust = STRATEGY_ADJUSTMENT_TABLE[strategy] ?? 0

  // --- weighted combo ---
  if (hasAnchors) {
    return clamp01(
      UTILITY_WEIGHTS.beliefConsistency * beliefConsistency +
        UTILITY_WEIGHTS.groupAlignment * groupAlignment +
        UTILITY_WEIGHTS.oracleMatch * oracleMatch +
        styleAdjust,
    )
  }
  return clamp01(
    W_BELIEF_NO_ORACLE * beliefConsistency +
      W_GROUP_NO_ORACLE * groupAlignment +
      styleAdjust,
  )
}

/* -------------------------------------------------------------------------- */
/* estimateUtility — string-based backward-compat API                         */
/* -------------------------------------------------------------------------- */

/**
 * Three components of u_i:
 *   - belief_consistency_i = 1 − update_kl_i / 2      ← 与自己一致
 *   - group_alignment_i    = avg cos(own, peer.latest) ← 与他人重叠
 *   - oracle_match_i       = max cos(own, anchor)    ← 与外部真值一致
 *
 * Strategy nudge: ±0.02..0.03 from STRATEGY_ADJUSTMENT_TABLE breaks the
 * 5-way symmetry so ε_t is observable.
 *
 * No-oracle fallback: redistributes the 0.3 oracle slice proportionally
 * to belief/group via {@link W_BELIEF_NO_ORACLE} / {@link W_GROUP_NO_ORACLE}
 * (preserves the 3:4 ratio).
 *
 * Implementation note: this is a thin wrapper around
 * {@link estimateUtilityCached} that builds a fresh UtilityCtx each
 * call. Hot paths should use the cached form directly.
 */
export function estimateUtility(args: {
  agentId: string
  strategy: RepairStyle
  records: readonly CavRecord[]
  oracleAnchors: readonly OracleAnchor[]
}): number {
  const { agentId, strategy, records, oracleAnchors } = args
  const ctx = buildUtilityCtx(records, oracleAnchors)
  return estimateUtilityCached({
    agentId,
    strategy,
    ctx,
    hasAnchors: oracleAnchors.length > 0,
  })
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}

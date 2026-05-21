/**
 * T1 — Pinned Constants tests.
 *
 * These tests pin the numeric & structural invariants documented in
 * `.kiro/specs/super-agent-cluster/design.md` "Pinned Constants" and
 * `requirements.md` (R3 / R6 / R12 / R13). Any future PR that bumps a
 * constant value MUST update both the design.md note and these tests
 * in the same change.
 */

import { describe, expect, it } from 'bun:test'

import {
  ADAPTIVE_DELTA_EPS_FLOOR,
  COST_IN_BITS_TABLE,
  DEFAULT_CR_EIG_WEIGHTS,
  EPISTEMIC_HONESTY_RULES,
  EPS_MAX,
  GRADIENT_IDS,
  INVOCATION_ANTI_PATTERNS,
  INVOCATION_GATE_PRECONDITIONS,
  KNOWLEDGE_ZONES,
  PROB_CLAMP_MAX,
  PROB_CLAMP_MIN,
  RANK_TIE_TOLERANCE,
  SIDECAR_DEGRADE_AFTER_MISSES,
  SIDECAR_POLL_BUDGET_MS,
  SIDECAR_POLL_INTERVAL_MS,
  STRATEGY_ADJUSTMENT_MAX_DELTA,
  STRATEGY_ADJUSTMENT_TABLE,
  STRATEGY_SPACE,
  UTILITY_WEIGHTS,
  W_BELIEF_NO_ORACLE,
  W_GROUP_NO_ORACLE,
} from '../constants.js'

describe('Constant 1 — COST_IN_BITS_TABLE', () => {
  it('has exactly 4 buckets in geometric ladder', () => {
    expect(Object.keys(COST_IN_BITS_TABLE).length).toBe(4)
    expect(COST_IN_BITS_TABLE.tiny).toBe(0.05)
    expect(COST_IN_BITS_TABLE.small).toBe(0.15)
    expect(COST_IN_BITS_TABLE.medium).toBe(0.4)
    expect(COST_IN_BITS_TABLE.large).toBe(1.0)
  })

  it('large is the maximum and equals 1.0 (matches binaryEntropy(0.5))', () => {
    const values = Object.values(COST_IN_BITS_TABLE)
    expect(Math.max(...values)).toBe(1.0)
    expect(COST_IN_BITS_TABLE.large).toBe(1.0)
  })

  it('values strictly increase tiny < small < medium < large', () => {
    expect(COST_IN_BITS_TABLE.tiny).toBeLessThan(COST_IN_BITS_TABLE.small)
    expect(COST_IN_BITS_TABLE.small).toBeLessThan(COST_IN_BITS_TABLE.medium)
    expect(COST_IN_BITS_TABLE.medium).toBeLessThan(COST_IN_BITS_TABLE.large)
  })
})

describe('Constant 2 — UTILITY_WEIGHTS + STRATEGY_ADJUSTMENT_TABLE', () => {
  it('forms a strict convex combination (Σ === 1.0 within ULP)', () => {
    const sum =
      UTILITY_WEIGHTS.beliefConsistency +
      UTILITY_WEIGHTS.groupAlignment +
      UTILITY_WEIGHTS.oracleMatch
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9)
  })

  it('groupAlignment dominates the other two slices', () => {
    expect(UTILITY_WEIGHTS.groupAlignment).toBeGreaterThan(
      UTILITY_WEIGHTS.beliefConsistency,
    )
    expect(UTILITY_WEIGHTS.groupAlignment).toBeGreaterThan(
      UTILITY_WEIGHTS.oracleMatch,
    )
  })

  it('no-oracle fallback weights still sum to 1', () => {
    const sum = W_BELIEF_NO_ORACLE + W_GROUP_NO_ORACLE
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9)
  })

  it('no-oracle group weight ≈ 0.5714 (4/7), belief weight ≈ 0.4286 (3/7)', () => {
    expect(W_BELIEF_NO_ORACLE).toBeCloseTo(3 / 7, 6)
    expect(W_GROUP_NO_ORACLE).toBeCloseTo(4 / 7, 6)
  })

  it('STRATEGY_ADJUSTMENT_TABLE has exactly 5 entries', () => {
    expect(Object.keys(STRATEGY_ADJUSTMENT_TABLE).length).toBe(5)
  })

  it('every strategy-adjustment value is bounded by STRATEGY_ADJUSTMENT_MAX_DELTA', () => {
    for (const [, v] of Object.entries(STRATEGY_ADJUSTMENT_TABLE)) {
      expect(Math.abs(v)).toBeLessThanOrEqual(STRATEGY_ADJUSTMENT_MAX_DELTA)
    }
  })

  it('concede has the largest positive nudge (consensus-honest signal)', () => {
    expect(STRATEGY_ADJUSTMENT_TABLE.concede).toBe(0.03)
    expect(STRATEGY_ADJUSTMENT_TABLE.concede).toBeGreaterThan(
      STRATEGY_ADJUSTMENT_TABLE.defend,
    )
  })

  it('substitute carries a small negative penalty (volatility tax)', () => {
    expect(STRATEGY_ADJUSTMENT_TABLE.substitute).toBeLessThan(0)
  })
})

describe('Constant 3 — EPS_MAX', () => {
  it('equals 1.0 to make ρ_t = 1 − ε_t algebraically tight', () => {
    expect(EPS_MAX).toBe(1.0)
  })
})

describe('Constant 4 — DEFAULT_CR_EIG_WEIGHTS', () => {
  it('has exactly the 6 fields R6-1 mandates', () => {
    const keys = Object.keys(DEFAULT_CR_EIG_WEIGHTS).sort()
    expect(keys).toEqual(
      [
        'deltaZero',
        'gammaCausal',
        'gammaExplore',
        'kappaUrgency',
        'lambdaCost',
        'useAdaptiveDelta',
      ].sort(),
    )
  })

  it('default weights honor R7-2 numeric envelope (1 + γ_caus·0.5 + κ = 1.35)', () => {
    const upper =
      1 +
      DEFAULT_CR_EIG_WEIGHTS.gammaCausal * 0.5 +
      DEFAULT_CR_EIG_WEIGHTS.kappaUrgency
    expect(upper).toBeCloseTo(1.35, 9)
    const lower = -DEFAULT_CR_EIG_WEIGHTS.lambdaCost * COST_IN_BITS_TABLE.large
    expect(lower).toBeCloseTo(-0.05, 9)
  })

  it('useAdaptiveDelta is on by default', () => {
    expect(DEFAULT_CR_EIG_WEIGHTS.useAdaptiveDelta).toBe(true)
  })
})

describe('Constant 5 — Sidecar polling parameters', () => {
  it('120 ms / 30 ms / 3 misses, in safe ratios', () => {
    expect(SIDECAR_POLL_INTERVAL_MS).toBe(120)
    expect(SIDECAR_POLL_BUDGET_MS).toBe(30)
    expect(SIDECAR_DEGRADE_AFTER_MISSES).toBe(3)
    expect(SIDECAR_POLL_BUDGET_MS).toBeLessThan(SIDECAR_POLL_INTERVAL_MS)
  })
})

describe('Constant 6 — INVOCATION_GATE_PRECONDITIONS', () => {
  it('has exactly 5 entries (R12-2)', () => {
    expect(INVOCATION_GATE_PRECONDITIONS.length).toBe(5)
  })

  it('every entry has id/title/summary fields', () => {
    for (const p of INVOCATION_GATE_PRECONDITIONS) {
      expect(p.id).toMatch(/^gate-/)
      expect(p.title.length).toBeGreaterThan(0)
      expect(p.summary.length).toBeGreaterThan(0)
    }
  })

  it('the 5 gate ids are exactly the canonical set', () => {
    const ids = INVOCATION_GATE_PRECONDITIONS.map(p => p.id).slice().sort()
    expect(ids).toEqual(
      [
        'gate-cross-validation',
        'gate-high-risk',
        'gate-knowledge-boundary',
        'gate-multi-perspective',
        'gate-single-stalled',
      ],
    )
  })
})

describe('Constant 7 — INVOCATION_ANTI_PATTERNS', () => {
  it('has at least 6 entries (R12-3)', () => {
    expect(INVOCATION_ANTI_PATTERNS.length).toBeGreaterThanOrEqual(6)
  })

  it('no entry is empty', () => {
    for (const p of INVOCATION_ANTI_PATTERNS) {
      expect(p.length).toBeGreaterThan(0)
    }
  })
})

describe('Constant 8 — EPISTEMIC_HONESTY_RULES + KNOWLEDGE_ZONES', () => {
  it('has exactly 5 rules with ids E1..E5', () => {
    expect(EPISTEMIC_HONESTY_RULES.length).toBe(5)
    const ids = EPISTEMIC_HONESTY_RULES.map(r => r.id)
    expect(ids).toEqual(['E1', 'E2', 'E3', 'E4', 'E5'])
  })

  it('every rule body is non-empty', () => {
    for (const r of EPISTEMIC_HONESTY_RULES) {
      expect(r.rule.length).toBeGreaterThan(20)
    }
  })

  it('KNOWLEDGE_ZONES has exactly the 3 canonical values', () => {
    expect([...KNOWLEDGE_ZONES]).toEqual(['core', 'edge', 'outside'])
  })
})

describe('Constant 9 — STRATEGY_SPACE / GRADIENT_IDS', () => {
  it('STRATEGY_SPACE matches the 5 RepairStyle members', () => {
    const got: string[] = [...STRATEGY_SPACE]
    expect(got.sort()).toEqual(
      ['concede', 'defend', 'none', 'split', 'substitute'],
    )
  })

  it('GRADIENT_IDS matches the 5 ∇H axes in lex-asc order', () => {
    const got: string[] = [...GRADIENT_IDS]
    expect(got).toEqual(['attack', 'chain', 'discretize', 'oracle', 'swap'])
  })
})

describe('Constant 10 — numerical guards', () => {
  it('PROB_CLAMP_MIN/MAX form an open interval inside (0, 1)', () => {
    expect(PROB_CLAMP_MIN).toBeGreaterThan(0)
    expect(PROB_CLAMP_MAX).toBeLessThan(1)
    expect(PROB_CLAMP_MIN).toBeLessThan(PROB_CLAMP_MAX)
  })

  it('ADAPTIVE_DELTA_EPS_FLOOR is small but positive', () => {
    expect(ADAPTIVE_DELTA_EPS_FLOOR).toBeGreaterThan(0)
    expect(ADAPTIVE_DELTA_EPS_FLOOR).toBeLessThanOrEqual(1e-3)
  })

  it('RANK_TIE_TOLERANCE is small but positive', () => {
    expect(RANK_TIE_TOLERANCE).toBeGreaterThan(0)
    expect(RANK_TIE_TOLERANCE).toBeLessThanOrEqual(1e-3)
  })
})

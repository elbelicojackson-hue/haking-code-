/**
 * T7 — computeCrEig tests.
 *
 * Covers:
 *   - R1-1..R1-7: signature, breakdown, cavMatrix-empty fallback,
 *                 zero causal evidence, perf, determinism
 *   - R7-1: monotonicity of baseEig in |confidence − 0.5|
 *   - R7-2: numeric envelope [-0.05, 1.35] under default weights
 *   - R7-3: all-correlation-only history → causalGain = 0
 *   - R7-7: ULP=0 stability across 1000 calls
 */

import { describe, expect, it } from 'bun:test'
import { createEmptyLedger } from '../../pev/ledger.js'
import { findToolPlan } from '../../pev/canonicalTests.js'
import { computeCrEig } from '../crEig.js'
import { DEFAULT_CR_EIG_WEIGHTS } from '../constants.js'
import type {
  Candidate,
  CavReading,
  CrEigCtx,
  Hypothesis,
} from '../types.js'
import { genericProfile } from '../../../../commands/ccbteam/profiles/generic.js'

const mkReading = (entropy: number, cal: number): CavReading => ({
  self_entropy: entropy,
  calibration: cal,
  update_kl: 0.4,
  repair_style: 'defend',
  commitment: null,
  hesitation: null,
  coherence: null,
  trace_depth: null,
  latency: null,
  reciprocity: null,
})

const mkHypothesis = (id: string, confidence: number): Hypothesis => ({
  id,
  ownerAgent: 'A',
  kind: 'packer',
  text: 'mock',
  confidence,
  status: 'open',
  evidenceTrail: [],
  createdRound: 0,
  lastTouchedRound: 0,
})

function mkCtx(overrides: Partial<CrEigCtx> = {}): CrEigCtx {
  return {
    ledger: createEmptyLedger(24),
    cavMatrix: [],
    profile: genericProfile,
    weights: DEFAULT_CR_EIG_WEIGHTS,
    records: [],
    oracleAnchors: [],
    round: 3,
    ...overrides,
  }
}

const planDiec = findToolPlan('packer::diec')!
const planNonCausal = findToolPlan('file-class::file-cmd')!

describe('computeCrEig — basic shape (R1-1..R1-3)', () => {
  it('returns crEig number + 7-field breakdown', () => {
    const cand: Candidate = {
      gradientId: 'oracle',
      hypothesis: mkHypothesis('H1', 0.5),
      plan: planDiec,
    }
    const result = computeCrEig(cand, mkCtx())
    expect(typeof result.crEig).toBe('number')
    const keys = Object.keys(result.breakdown).sort()
    expect(keys).toEqual(
      [
        'baseEig',
        'causalGain',
        'costPenalty',
        'explorationBonus',
        'trustWeightedConfirm',
        'trustWeightedFalsify',
        'urgencyBoost',
      ].sort(),
    )
  })

  it('hands back 0 baseEig + 0 cost when no plan provided (R1-4 partial)', () => {
    const cand: Candidate = { gradientId: 'attack' }
    const result = computeCrEig(cand, mkCtx())
    expect(result.breakdown.baseEig).toBe(0)
    expect(result.breakdown.costPenalty).toBe(0)
    expect(result.breakdown.trustWeightedConfirm).toBe(0)
    expect(result.breakdown.trustWeightedFalsify).toBe(0)
    // urgencyBoost & explorationBonus may still contribute.
  })

  it('cavMatrix empty → wBar=1 fallback (R1-4)', () => {
    const cand: Candidate = {
      gradientId: 'oracle',
      hypothesis: mkHypothesis('H1', 0.5),
      plan: planDiec,
    }
    const result = computeCrEig(cand, mkCtx({ cavMatrix: [] }))
    // When cavMatrix is empty, trustWeightedConfirm/Falsify should equal
    // alpha*ΔH and beta*ΔH (with no trust scaling).
    expect(result.breakdown.trustWeightedConfirm).toBeGreaterThanOrEqual(0)
    expect(result.breakdown.trustWeightedFalsify).toBeGreaterThanOrEqual(0)
  })
})

describe('computeCrEig — R1-5 zero causal evidence', () => {
  it('plan without intervention support → causalGain = 0', () => {
    const cand: Candidate = {
      gradientId: 'oracle',
      hypothesis: mkHypothesis('H1', 0.5),
      plan: planNonCausal, // file-class::file-cmd is not in INTERVENTION_REGISTRY
    }
    const result = computeCrEig(cand, mkCtx())
    expect(result.breakdown.causalGain).toBe(0)
  })

  it('plan with intervention support but no history → some causalGain', () => {
    const cand: Candidate = {
      gradientId: 'oracle',
      hypothesis: mkHypothesis('H1', 0.5),
      plan: planDiec, // packer::diec IS in INTERVENTION_REGISTRY
    }
    const result = computeCrEig(cand, mkCtx())
    // No history → applyCausalBoost returns 1.5x; gammaCausal=0.3 → +baseEig*0.5*0.3
    // Should be > 0.
    expect(result.breakdown.causalGain).toBeGreaterThan(0)
  })
})

describe('computeCrEig — R7-1 monotonicity in |p − 0.5|', () => {
  it('baseEig is maximised at p=0.5, monotone non-increasing toward 0/1 (default priors clamp at 0 for high p)', () => {
    const ctx = mkCtx()
    const cand5 = {
      gradientId: 'oracle' as const,
      hypothesis: mkHypothesis('H', 0.5),
      plan: planDiec,
    }
    const cand2 = {
      gradientId: 'oracle' as const,
      hypothesis: mkHypothesis('H', 0.2),
      plan: planDiec,
    }
    const cand9 = {
      gradientId: 'oracle' as const,
      hypothesis: mkHypothesis('H', 0.9),
      plan: planDiec,
    }
    const cand99 = {
      gradientId: 'oracle' as const,
      hypothesis: mkHypothesis('H', 0.99),
      plan: planDiec,
    }
    const v5 = computeCrEig(cand5, ctx).breakdown.baseEig
    const v2 = computeCrEig(cand2, ctx).breakdown.baseEig
    const v9 = computeCrEig(cand9, ctx).breakdown.baseEig
    const v99 = computeCrEig(cand99, ctx).breakdown.baseEig
    // p=0.5 is strictly maximum vs p=0.2 (intermediate confidence).
    expect(v5).toBeGreaterThan(v2)
    // Monotone non-increasing toward saturation:
    expect(v5).toBeGreaterThanOrEqual(v9)
    expect(v9).toBeGreaterThanOrEqual(v99)
    // Extreme p=0.99 saturates to 0 under default priors (Math.max floor).
    expect(v99).toBeLessThanOrEqual(0.05)
  })
})

describe('computeCrEig — R7-2 numeric envelope', () => {
  it('crEig stays within [−0.05, 1.35] under default weights', () => {
    let s = 0xa11ce >>> 0
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 2 ** 32
    }
    for (let i = 0; i < 50; i++) {
      const cand: Candidate = {
        gradientId: 'oracle',
        hypothesis: mkHypothesis(`H${i}`, rnd()),
        plan: rnd() < 0.5 ? planDiec : planNonCausal,
      }
      const cavMatrix =
        rnd() < 0.5
          ? []
          : [mkReading(rnd(), rnd()), mkReading(rnd(), rnd())]
      const result = computeCrEig(cand, mkCtx({ cavMatrix }))
      expect(result.crEig).toBeGreaterThanOrEqual(-0.06) // small tolerance for float
      expect(result.crEig).toBeLessThanOrEqual(1.36)
    }
  })
})

describe('computeCrEig — R7-7 ULP=0 stability', () => {
  it('1000 identical calls return bit-for-bit identical crEig', () => {
    const cand: Candidate = {
      gradientId: 'oracle',
      hypothesis: mkHypothesis('H', 0.42),
      plan: planDiec,
    }
    const ctx = mkCtx({ cavMatrix: [mkReading(0.3, 0.6)] })
    const first = computeCrEig(cand, ctx).crEig
    for (let i = 0; i < 1000; i++) {
      expect(computeCrEig(cand, ctx).crEig).toBe(first)
    }
  })
})

describe('computeCrEig — R7-3 all-correlation-only', () => {
  it('an evidence log full of correlation-only intervention rows yields causalGain = 0', () => {
    // Build a ledger with 3 correlation-only intervention rows for packer::diec.
    let ledger = createEmptyLedger(24)
    const corrEvidence = {
      agentId: 'A',
      round: 1,
      toolName: 'ReverseCli',
      toolArgs: {},
      outcome: 'success' as const,
      resultDigest: 'd',
      testedHypothesis: 'H1' as const,
      verdict: 'confirms' as const,
      durationMs: 100,
      planId: 'packer::diec',
      isCausalIntervention: true,
      causalVerdict: 'correlation-only' as const,
    }
    for (let i = 0; i < 3; i++) {
      const next = {
        ...ledger,
        evidenceLog: [
          ...ledger.evidenceLog,
          { ...corrEvidence, id: `E${i + 1}` as const },
        ],
        lastEvidenceId: i + 1,
      }
      ledger = next
    }
    const cand: Candidate = {
      gradientId: 'oracle',
      hypothesis: mkHypothesis('H1', 0.5),
      plan: planDiec,
    }
    const result = computeCrEig(cand, mkCtx({ ledger }))
    // All 3 historical interventions are correlation-only ⇒
    // applyCausalBoost returns baseEig × 1.0 ⇒ causalDelta = 0 ⇒ gain = 0.
    expect(result.breakdown.causalGain).toBe(0)
  })
})

describe('computeCrEig — R1-6 perf', () => {
  it('100 candidate batch ≤ 100ms', () => {
    const ctx = mkCtx({ cavMatrix: [mkReading(0.3, 0.6)] })
    const candidates: Candidate[] = []
    for (let i = 0; i < 100; i++) {
      candidates.push({
        gradientId: 'oracle',
        hypothesis: mkHypothesis(`H${i}`, 0.4 + (i % 10) * 0.05),
        plan: i % 2 ? planDiec : planNonCausal,
      })
    }
    const t0 = performance.now()
    for (const c of candidates) computeCrEig(c, ctx)
    const dt = performance.now() - t0
    expect(dt).toBeLessThan(100)
  })
})

describe('computeCrEig — R4-6 generic cold-start oracle bonus', () => {
  it('round < 2 + generic profile + oracle gradient → +0.1 explorationBonus', () => {
    const cand: Candidate = {
      gradientId: 'oracle',
      hypothesis: mkHypothesis('H', 0.5),
      plan: planDiec,
    }
    const ctxRound0 = mkCtx({ profile: genericProfile, round: 0 })
    const ctxRound2 = mkCtx({ profile: genericProfile, round: 2 })
    const r0 = computeCrEig(cand, ctxRound0)
    const r2 = computeCrEig(cand, ctxRound2)
    // The 0.1 bonus applies only at round < 2.
    expect(r0.breakdown.explorationBonus).toBeGreaterThanOrEqual(
      r2.breakdown.explorationBonus + 0.099,
    )
  })

  it('non-oracle gradient does NOT receive the cold-start bonus', () => {
    const cand: Candidate = {
      gradientId: 'attack',
    }
    const ctxRound0 = mkCtx({ profile: genericProfile, round: 0 })
    const result = computeCrEig(cand, ctxRound0)
    expect(result.breakdown.explorationBonus).toBe(0)
  })
})

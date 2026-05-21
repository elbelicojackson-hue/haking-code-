/**
 * EIG Engine — unit + property-based tests.
 */

import { describe, expect, test } from 'bun:test'
import * as fc from 'fast-check'
import {
  binaryEntropy,
  computeEIG,
  computeExplorationBonus,
  multinomialEntropy,
  rankCandidates,
  type EIGCandidate,
} from '../eigEngine.js'
import { createEmptyLedger, appendEvidence, type Hypothesis, type SharedLedger } from '../ledger.js'
import { findToolPlan } from '../canonicalTests.js'
import type { PlanStats } from '../planStats.js'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function makeH(overrides: Partial<Hypothesis> & { id: string }): Hypothesis {
  return {
    ownerAgent: 'A',
    kind: 'packer',
    text: 'test hypothesis text long enough',
    confidence: 0.5,
    status: 'open',
    evidenceTrail: [],
    createdRound: 0,
    lastTouchedRound: 0,
    ...overrides,
  }
}

const SYMMETRIC_PRIORS: PlanStats = {
  confirmRate: 0.5,
  falsifyRate: 0.5,
  inconclusiveRate: 0,
  sampleCount: 10,
}

const UNIFORM_PRIORS: PlanStats = {
  confirmRate: 0.4,
  falsifyRate: 0.4,
  inconclusiveRate: 0.2,
  sampleCount: 0,
}

/* -------------------------------------------------------------------------- */
/* binaryEntropy                                                              */
/* -------------------------------------------------------------------------- */

describe('binaryEntropy', () => {
  test('H(0.5) = 1.0 (maximum entropy)', () => {
    expect(binaryEntropy(0.5)).toBeCloseTo(1.0, 5)
  })

  test('H(0) = 0 (certainty)', () => {
    expect(binaryEntropy(0)).toBe(0)
  })

  test('H(1) = 0 (certainty)', () => {
    expect(binaryEntropy(1)).toBe(0)
  })

  test('H(0.9) < H(0.5) (more certain = less entropy)', () => {
    expect(binaryEntropy(0.9)).toBeLessThan(binaryEntropy(0.5))
  })

  test('symmetric: H(p) = H(1-p)', () => {
    expect(binaryEntropy(0.3)).toBeCloseTo(binaryEntropy(0.7), 10)
    expect(binaryEntropy(0.1)).toBeCloseTo(binaryEntropy(0.9), 10)
  })
})

/* -------------------------------------------------------------------------- */
/* computeEIG                                                                 */
/* -------------------------------------------------------------------------- */

describe('computeEIG', () => {
  const plan = findToolPlan('packer::diec')!
  const ledger = createEmptyLedger(24)

  test('confidence=0.5 + symmetric priors → EIG near maximum', () => {
    const h = makeH({ id: 'H1', confidence: 0.5 })
    const result = computeEIG(h, plan, ledger, SYMMETRIC_PRIORS)
    // At p=0.5 with symmetric confirm/falsify and step=0.2, EIG is ~0.029
    expect(result.eig).toBeGreaterThan(0.01)
    expect(result.eig).toBeLessThanOrEqual(1.0)
  })

  test('confidence=0.99 → EIG near 0 (already certain)', () => {
    const h = makeH({ id: 'H1', confidence: 0.99 })
    const result = computeEIG(h, plan, ledger, SYMMETRIC_PRIORS)
    expect(result.eig).toBeLessThan(0.1)
  })

  test('confidence=0.01 → EIG near 0 (already certain the other way)', () => {
    const h = makeH({ id: 'H1', confidence: 0.01 })
    const result = computeEIG(h, plan, ledger, SYMMETRIC_PRIORS)
    expect(result.eig).toBeLessThan(0.1)
  })

  test('EIG(p=0.5) > EIG(p=0.9) with symmetric priors', () => {
    const h05 = makeH({ id: 'H1', confidence: 0.5 })
    const h09 = makeH({ id: 'H2', confidence: 0.9 })
    const eig05 = computeEIG(h05, plan, ledger, SYMMETRIC_PRIORS).eig
    const eig09 = computeEIG(h09, plan, ledger, SYMMETRIC_PRIORS).eig
    expect(eig05).toBeGreaterThan(eig09)
  })

  test('EIG is never negative', () => {
    const h = makeH({ id: 'H1', confidence: 0.7 })
    const result = computeEIG(h, plan, ledger, UNIFORM_PRIORS)
    expect(result.eig).toBeGreaterThanOrEqual(0)
  })

  test('breakdown fields are populated', () => {
    const h = makeH({ id: 'H1', confidence: 0.6 })
    const result = computeEIG(h, plan, ledger, UNIFORM_PRIORS)
    expect(result.breakdown.priorEntropy).toBeGreaterThan(0)
    expect(result.breakdown.confirmProb).toBeCloseTo(0.4, 5)
    expect(result.breakdown.falsifyProb).toBeCloseTo(0.4, 5)
    expect(result.breakdown.inconclusiveProb).toBeCloseTo(0.2, 5)
    expect(result.breakdown.posteriorIfConfirm).toBeGreaterThan(0.6)
    expect(result.breakdown.posteriorIfFalsify).toBeLessThan(0.6)
  })

  test('all-inconclusive plan → EIG = 0 (no information)', () => {
    const h = makeH({ id: 'H1', confidence: 0.5 })
    const allInconclusive: PlanStats = {
      confirmRate: 0,
      falsifyRate: 0,
      inconclusiveRate: 1.0,
      sampleCount: 10,
    }
    const result = computeEIG(h, plan, ledger, allInconclusive)
    expect(result.eig).toBeCloseTo(0, 5)
  })
})

/* -------------------------------------------------------------------------- */
/* computeExplorationBonus                                                    */
/* -------------------------------------------------------------------------- */

describe('computeExplorationBonus', () => {
  const plan = findToolPlan('packer::diec')!

  test('untested (H, plan) → bonus > 0', () => {
    const h = makeH({ id: 'H1' })
    const ledger = createEmptyLedger(24)
    const bonus = computeExplorationBonus(h, plan, ledger, 0.1)
    expect(bonus).toBeGreaterThan(0)
  })

  test('already tested (H, plan) → bonus = 0', () => {
    const h = makeH({ id: 'H1' })
    let ledger = createEmptyLedger(24)
    ledger = appendEvidence(ledger, {
      agentId: 'A',
      round: 0,
      toolName: 'ReverseCli', // packer::diec uses ReverseCli
      toolArgs: {},
      outcome: 'success',
      resultDigest: '',
      testedHypothesis: 'H1',
      verdict: 'confirms',
      durationMs: 1,
    }).ledger
    const bonus = computeExplorationBonus(h, plan, ledger, 0.1)
    expect(bonus).toBe(0)
  })

  test('weight=0 → bonus always 0', () => {
    const h = makeH({ id: 'H1' })
    const ledger = createEmptyLedger(24)
    expect(computeExplorationBonus(h, plan, ledger, 0)).toBe(0)
  })

  test('bonus decreases as more tools test the same H', () => {
    const h = makeH({ id: 'H1' })
    let ledger = createEmptyLedger(24)
    const bonus0 = computeExplorationBonus(h, plan, ledger, 0.1)

    // Add evidence from a different tool
    ledger = appendEvidence(ledger, {
      agentId: 'A',
      round: 0,
      toolName: 'Bash',
      toolArgs: {},
      outcome: 'success',
      resultDigest: '',
      testedHypothesis: 'H1',
      verdict: 'confirms',
      durationMs: 1,
    }).ledger
    const bonus1 = computeExplorationBonus(h, plan, ledger, 0.1)
    expect(bonus1).toBeLessThan(bonus0)
  })
})

/* -------------------------------------------------------------------------- */
/* rankCandidates                                                             */
/* -------------------------------------------------------------------------- */

describe('rankCandidates', () => {
  const plan = findToolPlan('packer::diec')!
  const planSmall = findToolPlan('packer::upx-test')!

  test('sorts by total score descending', () => {
    const candidates: EIGCandidate[] = [
      { hypothesis: makeH({ id: 'H1' }), plan, eig: 0.3, explorationBonus: 0, total: 0.3, breakdown: {} as any },
      { hypothesis: makeH({ id: 'H2' }), plan, eig: 0.8, explorationBonus: 0, total: 0.8, breakdown: {} as any },
      { hypothesis: makeH({ id: 'H3' }), plan, eig: 0.5, explorationBonus: 0.1, total: 0.6, breakdown: {} as any },
    ]
    const sorted = rankCandidates(candidates)
    expect(sorted[0]!.hypothesis.id).toBe('H2')
    expect(sorted[1]!.hypothesis.id).toBe('H3')
    expect(sorted[2]!.hypothesis.id).toBe('H1')
  })

  test('tie-break by cost ascending', () => {
    const candidates: EIGCandidate[] = [
      { hypothesis: makeH({ id: 'H1' }), plan: { ...plan, cost_estimate: 'large' } as any, eig: 0.5, explorationBonus: 0, total: 0.5, breakdown: {} as any },
      { hypothesis: makeH({ id: 'H2' }), plan: { ...plan, cost_estimate: 'tiny' } as any, eig: 0.5, explorationBonus: 0, total: 0.5, breakdown: {} as any },
    ]
    const sorted = rankCandidates(candidates)
    expect(sorted[0]!.hypothesis.id).toBe('H2') // tiny < large
  })

  test('tie-break by hypothesis id ascending', () => {
    const candidates: EIGCandidate[] = [
      { hypothesis: makeH({ id: 'H3' }), plan, eig: 0.5, explorationBonus: 0, total: 0.5, breakdown: {} as any },
      { hypothesis: makeH({ id: 'H1' }), plan, eig: 0.5, explorationBonus: 0, total: 0.5, breakdown: {} as any },
    ]
    const sorted = rankCandidates(candidates)
    expect(sorted[0]!.hypothesis.id).toBe('H1')
  })
})

/* -------------------------------------------------------------------------- */
/* PBT — EIG ∈ [0, 1]                                                        */
/* -------------------------------------------------------------------------- */

describe('PBT — EIG properties', () => {
  const plan = findToolPlan('packer::diec')!
  const ledger = createEmptyLedger(24)

  test('EIG is always in [0, 1] for any confidence', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1, noNaN: true }),
        confidence => {
          const h = makeH({ id: 'H1', confidence })
          const result = computeEIG(h, plan, ledger, UNIFORM_PRIORS)
          return result.eig >= 0 && result.eig <= 1
        },
      ),
      { numRuns: 200 },
    )
  })

  test('EIG(p=0.5) ≥ EIG(p) for any p with symmetric priors', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.01, max: 0.99, noNaN: true }),
        p => {
          const h05 = makeH({ id: 'H1', confidence: 0.5 })
          const hP = makeH({ id: 'H2', confidence: p })
          const eig05 = computeEIG(h05, plan, ledger, SYMMETRIC_PRIORS).eig
          const eigP = computeEIG(hP, plan, ledger, SYMMETRIC_PRIORS).eig
          return eig05 >= eigP - 1e-9 // tolerance for floating point
        },
      ),
      { numRuns: 200 },
    )
  })

  test('binaryEntropy is always in [0, 1]', () => {
    fc.assert(
      fc.property(
        fc.float({ min: 0, max: 1, noNaN: true }),
        p => {
          const h = binaryEntropy(p)
          return h >= 0 && h <= 1
        },
      ),
      { numRuns: 200 },
    )
  })
})

/* -------------------------------------------------------------------------- */
/* multinomialEntropy                                                         */
/* -------------------------------------------------------------------------- */

describe('multinomialEntropy', () => {
  test('empty array → 0', () => {
    expect(multinomialEntropy([])).toBe(0)
  })

  test('single certainty [1.0] → 0', () => {
    expect(multinomialEntropy([1.0])).toBe(0)
  })

  test('binary uniform [0.5, 0.5] → 1.0 (matches binaryEntropy)', () => {
    expect(multinomialEntropy([0.5, 0.5])).toBeCloseTo(1.0, 5)
    expect(multinomialEntropy([0.5, 0.5])).toBeCloseTo(binaryEntropy(0.5), 5)
  })

  test('binary [0.3, 0.7] matches binaryEntropy(0.3)', () => {
    expect(multinomialEntropy([0.3, 0.7])).toBeCloseTo(binaryEntropy(0.3), 5)
  })

  test('ternary uniform [1/3, 1/3, 1/3] → log₂(3) ≈ 1.585', () => {
    const p = 1 / 3
    expect(multinomialEntropy([p, p, p])).toBeCloseTo(Math.log2(3), 5)
  })

  test('quaternary uniform [0.25, 0.25, 0.25, 0.25] → 2.0 bits', () => {
    expect(multinomialEntropy([0.25, 0.25, 0.25, 0.25])).toBeCloseTo(2.0, 5)
  })

  test('skewed distribution has less entropy than uniform', () => {
    const uniform = multinomialEntropy([0.25, 0.25, 0.25, 0.25])
    const skewed = multinomialEntropy([0.7, 0.1, 0.1, 0.1])
    expect(skewed).toBeLessThan(uniform)
  })

  test('handles zero probabilities gracefully (0·log₂(0) = 0)', () => {
    // [0.5, 0.5, 0] should equal [0.5, 0.5]
    expect(multinomialEntropy([0.5, 0.5, 0])).toBeCloseTo(
      multinomialEntropy([0.5, 0.5]),
      5,
    )
  })

  test('result is always non-negative', () => {
    fc.assert(
      fc.property(
        fc.array(fc.float({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 8 }),
        probs => {
          return multinomialEntropy(probs) >= 0
        },
      ),
      { numRuns: 200 },
    )
  })

  test('entropy increases with number of equally-likely outcomes', () => {
    const h2 = multinomialEntropy([0.5, 0.5])
    const h3 = multinomialEntropy([1 / 3, 1 / 3, 1 / 3])
    const h4 = multinomialEntropy([0.25, 0.25, 0.25, 0.25])
    expect(h3).toBeGreaterThan(h2)
    expect(h4).toBeGreaterThan(h3)
  })
})

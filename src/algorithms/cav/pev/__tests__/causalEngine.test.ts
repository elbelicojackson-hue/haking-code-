/**
 * Causal Inference Engine — unit tests.
 *
 * Validates the do-calculus style intervention comparison logic that
 * distinguishes causation from correlation.
 */

import { describe, expect, test } from 'bun:test'
import {
  applyCausalBoost,
  compareCausalVerdicts,
  computeCausalConfidence,
  getInterventionVariant,
  INTERVENTION_REGISTRY,
  supportsCausalInference,
  type CausalResult,
  type InterventionVariant,
} from '../causalEngine.js'

/* -------------------------------------------------------------------------- */
/* Intervention Registry                                                      */
/* -------------------------------------------------------------------------- */

describe('INTERVENTION_REGISTRY', () => {
  test('packer::diec has an intervention variant', () => {
    const v = getInterventionVariant('packer::diec')
    expect(v).toBeDefined()
    expect(v!.manipulatedVariable).toContain('UPX')
    expect(v!.expectedEffectIfCausal).toBe('breaks-confirm')
  })

  test('unknown plan returns undefined', () => {
    expect(getInterventionVariant('does::not-exist')).toBeUndefined()
  })

  test('supportsCausalInference returns true for registered plans', () => {
    expect(supportsCausalInference('packer::diec')).toBe(true)
    expect(supportsCausalInference('packer::upx-test')).toBe(true)
    expect(supportsCausalInference('compiler::dnspy-probe')).toBe(true)
    expect(supportsCausalInference('protocol::tshark')).toBe(true)
    expect(supportsCausalInference('protocol::mitm-capture')).toBe(true)
    expect(supportsCausalInference('protocol::strings-protocol-tokens')).toBe(true)
  })

  test('supportsCausalInference returns false for unregistered plans', () => {
    expect(supportsCausalInference('algorithm::ida-script-dump')).toBe(false)
    expect(supportsCausalInference('family::strings-grep')).toBe(false)
  })

  test('every registered variant has required fields', () => {
    for (const [id, v] of Object.entries(INTERVENTION_REGISTRY)) {
      expect(v.description.length).toBeGreaterThan(0)
      expect(v.manipulatedVariable.length).toBeGreaterThan(0)
      expect(v.expectedEffectIfCausal).toBe('breaks-confirm')
      expect(typeof v.interventionArgs).toBe('object')
    }
  })
})

/* -------------------------------------------------------------------------- */
/* compareCausalVerdicts                                                      */
/* -------------------------------------------------------------------------- */

describe('compareCausalVerdicts', () => {
  const variant: InterventionVariant = {
    description: 'test intervention',
    interventionArgs: {},
    manipulatedVariable: 'test variable',
    expectedEffectIfCausal: 'breaks-confirm',
  }

  test('confirms + falsifies → causal-confirm (strength 1.0)', () => {
    const r = compareCausalVerdicts('confirms', 'falsifies', variant)
    expect(r.causalVerdict).toBe('causal-confirm')
    expect(r.causalStrength).toBe(1.0)
    expect(r.explanation).toContain('TRUE causation')
  })

  test('confirms + inconclusive → causal-confirm (strength 0.7)', () => {
    const r = compareCausalVerdicts('confirms', 'inconclusive', variant)
    expect(r.causalVerdict).toBe('causal-confirm')
    expect(r.causalStrength).toBe(0.7)
    expect(r.explanation).toContain('likely causal')
  })

  test('confirms + confirms → correlation-only (strength 0)', () => {
    const r = compareCausalVerdicts('confirms', 'confirms', variant)
    expect(r.causalVerdict).toBe('correlation-only')
    expect(r.causalStrength).toBe(0)
    expect(r.explanation).toContain('correlation only')
  })

  test('falsifies + anything → causal-falsify', () => {
    for (const iv of ['confirms', 'falsifies', 'inconclusive', 'mutates'] as const) {
      const r = compareCausalVerdicts('falsifies', iv, variant)
      expect(r.causalVerdict).toBe('causal-falsify')
      expect(r.causalStrength).toBe(1.0)
    }
  })

  test('inconclusive + anything → inconclusive', () => {
    for (const iv of ['confirms', 'falsifies', 'inconclusive'] as const) {
      const r = compareCausalVerdicts('inconclusive', iv, variant)
      expect(r.causalVerdict).toBe('inconclusive')
      expect(r.causalStrength).toBe(0)
    }
  })

  test('mutates + anything → inconclusive', () => {
    const r = compareCausalVerdicts('mutates', 'confirms', variant)
    expect(r.causalVerdict).toBe('inconclusive')
  })

  test('result always contains both original and intervention verdicts', () => {
    const r = compareCausalVerdicts('confirms', 'falsifies', variant)
    expect(r.originalVerdict).toBe('confirms')
    expect(r.interventionVerdict).toBe('falsifies')
  })
})

/* -------------------------------------------------------------------------- */
/* applyCausalBoost                                                           */
/* -------------------------------------------------------------------------- */

describe('applyCausalBoost', () => {
  test('plan with intervention gets 1.5× EIG boost (legacy 2-arg)', () => {
    const boosted = applyCausalBoost(0.5, 'packer::diec')
    expect(boosted).toBeCloseTo(0.75, 5)
  })

  test('plan without intervention gets no boost', () => {
    const boosted = applyCausalBoost(0.5, 'algorithm::ida-script-dump')
    expect(boosted).toBe(0.5)
  })

  test('boost of 0 EIG is still 0', () => {
    expect(applyCausalBoost(0, 'packer::diec')).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* applyCausalBoost — ledger-aware (dynamic) boost                            */
/* -------------------------------------------------------------------------- */

describe('applyCausalBoost (ledger-aware)', () => {
  // Local imports for the ledger-construction helpers.
  // These are deliberately scoped inside the describe block to keep the
  // top-of-file import list tidy.
  const { createEmptyLedger, appendEvidence } = require('../ledger.js') as
    typeof import('../ledger.js')

  function makeLedgerWithInterventionEvidence(rows: Array<{
    planId: string
    causalVerdict: 'causal-confirm' | 'correlation-only' | 'causal-falsify' | 'inconclusive'
    causalStrength: number
  }>) {
    let ledger = createEmptyLedger(24)
    for (const r of rows) {
      ledger = appendEvidence(ledger, {
        agentId: 'A',
        round: 0,
        toolName: 'ReverseCli',
        toolArgs: {},
        outcome: 'success',
        resultDigest: '',
        testedHypothesis: 'H1',
        verdict: 'confirms',
        durationMs: 1,
        planId: r.planId,
        isCausalIntervention: true,
        causalVerdict: r.causalVerdict,
        causalStrength: r.causalStrength,
      }).ledger
    }
    return ledger
  }

  test('no intervention history → optimistic 1.5× boost', () => {
    const ledger = createEmptyLedger(24)
    const boosted = applyCausalBoost(0.5, 'packer::diec', ledger)
    expect(boosted).toBeCloseTo(0.75, 5)
  })

  test('100% causal-confirm history → full 1.5× boost', () => {
    const ledger = makeLedgerWithInterventionEvidence([
      { planId: 'packer::diec', causalVerdict: 'causal-confirm', causalStrength: 1 },
      { planId: 'packer::diec', causalVerdict: 'causal-confirm', causalStrength: 1 },
    ])
    const boosted = applyCausalBoost(0.5, 'packer::diec', ledger)
    expect(boosted).toBeCloseTo(0.75, 5)
  })

  test('100% correlation-only history → no boost (1.0×)', () => {
    const ledger = makeLedgerWithInterventionEvidence([
      { planId: 'packer::diec', causalVerdict: 'correlation-only', causalStrength: 0 },
      { planId: 'packer::diec', causalVerdict: 'correlation-only', causalStrength: 0 },
    ])
    const boosted = applyCausalBoost(0.5, 'packer::diec', ledger)
    expect(boosted).toBeCloseTo(0.5, 5)
  })

  test('50/50 causal-confirm vs correlation-only → 1.25× boost', () => {
    const ledger = makeLedgerWithInterventionEvidence([
      { planId: 'packer::diec', causalVerdict: 'causal-confirm', causalStrength: 1 },
      { planId: 'packer::diec', causalVerdict: 'correlation-only', causalStrength: 0 },
    ])
    const boosted = applyCausalBoost(0.5, 'packer::diec', ledger)
    // 1 + 0.5 × 0.5 = 1.25 multiplier
    expect(boosted).toBeCloseTo(0.625, 5)
  })

  test('history for a different plan is ignored', () => {
    const ledger = makeLedgerWithInterventionEvidence([
      // History for upx-test, not diec
      { planId: 'packer::upx-test', causalVerdict: 'correlation-only', causalStrength: 0 },
      { planId: 'packer::upx-test', causalVerdict: 'correlation-only', causalStrength: 0 },
    ])
    // Asking about diec — no diec history, so optimistic 1.5×
    const boosted = applyCausalBoost(0.5, 'packer::diec', ledger)
    expect(boosted).toBeCloseTo(0.75, 5)
  })

  test('non-intervention evidence is ignored', () => {
    let ledger = createEmptyLedger(24)
    // Append a regular (non-intervention) evidence row for the same plan
    ledger = appendEvidence(ledger, {
      agentId: 'A',
      round: 0,
      toolName: 'ReverseCli',
      toolArgs: {},
      outcome: 'success',
      resultDigest: '',
      testedHypothesis: 'H1',
      verdict: 'confirms',
      durationMs: 1,
      planId: 'packer::diec',
      // isCausalIntervention NOT set → this is the original, not the intervention
    }).ledger
    // Should still be 1.5× (no intervention rows yet)
    const boosted = applyCausalBoost(0.5, 'packer::diec', ledger)
    expect(boosted).toBeCloseTo(0.75, 5)
  })

  test('plan without intervention support → no boost regardless of ledger', () => {
    const ledger = makeLedgerWithInterventionEvidence([
      { planId: 'packer::diec', causalVerdict: 'causal-confirm', causalStrength: 1 },
    ])
    const boosted = applyCausalBoost(0.5, 'algorithm::ida-script-dump', ledger)
    expect(boosted).toBe(0.5)
  })
})

/* -------------------------------------------------------------------------- */
/* computeCausalConfidence                                                    */
/* -------------------------------------------------------------------------- */

describe('computeCausalConfidence', () => {
  test('empty results → 0 fraction, 0 strength', () => {
    const { causalFraction, avgStrength } = computeCausalConfidence([])
    expect(causalFraction).toBe(0)
    expect(avgStrength).toBe(0)
  })

  test('all causal-confirm → fraction=1.0', () => {
    const results: CausalResult[] = [
      { causalVerdict: 'causal-confirm', originalVerdict: 'confirms', interventionVerdict: 'falsifies', causalStrength: 1.0, explanation: '' },
      { causalVerdict: 'causal-confirm', originalVerdict: 'confirms', interventionVerdict: 'inconclusive', causalStrength: 0.7, explanation: '' },
    ]
    const { causalFraction, avgStrength } = computeCausalConfidence(results)
    expect(causalFraction).toBe(1.0)
    expect(avgStrength).toBeCloseTo(0.85, 5)
  })

  test('mixed results → correct fraction', () => {
    const results: CausalResult[] = [
      { causalVerdict: 'causal-confirm', originalVerdict: 'confirms', interventionVerdict: 'falsifies', causalStrength: 1.0, explanation: '' },
      { causalVerdict: 'correlation-only', originalVerdict: 'confirms', interventionVerdict: 'confirms', causalStrength: 0, explanation: '' },
      { causalVerdict: 'inconclusive', originalVerdict: 'inconclusive', interventionVerdict: 'confirms', causalStrength: 0, explanation: '' },
    ]
    const { causalFraction, avgStrength } = computeCausalConfidence(results)
    expect(causalFraction).toBeCloseTo(1 / 3, 5)
    expect(avgStrength).toBeCloseTo(1 / 3, 5)
  })
})

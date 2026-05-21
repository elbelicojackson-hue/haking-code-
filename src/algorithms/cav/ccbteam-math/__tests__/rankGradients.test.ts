/**
 * T9 — rankGradients tests.
 *
 * Covers:
 *   - R4-1: returns 5 axes always
 *   - R4-2: RankedGradient shape + modelChose=false initially
 *   - R4-3: tie-break order primary→secondary→tertiary
 *   - R4-4: every score went through computeCrEig (verified by
 *           lambdaCost=0 / kappaUrgency=0 → all-zero scores → tie-break
 *           falls to lex-asc only)
 *   - R4-5: deterministic
 *   - R4-6: cold-start oracle bonus (verified in T7 crEig.test; here we
 *           only check that the rankGradients result still respects it)
 */

import { describe, expect, it } from 'bun:test'
import { createEmptyLedger } from '../../pev/ledger.js'
import { rankGradients } from '../rankGradients.js'
import { DEFAULT_CR_EIG_WEIGHTS, GRADIENT_IDS } from '../constants.js'
import type { CavRecord, RepairStyle } from '../types.js'
import { genericProfile } from '../../../../commands/ccbteam/profiles/generic.js'

const rec = (
  agentId: string,
  claim: string,
  style: RepairStyle = 'defend',
  selfEntropy = 0.3,
  turn = 0,
): CavRecord => ({
  sessionId: 'test',
  teamName: 'team',
  agentId,
  agentName: agentId,
  model: 'mock',
  turn,
  timestamp: 0,
  claim,
  cav: {
    self_entropy: selfEntropy,
    calibration: 0.7,
    update_kl: 0.4,
    repair_style: style,
    commitment: null,
    hesitation: null,
    coherence: null,
    trace_depth: null,
    latency: null,
    reciprocity: null,
  },
})

describe('rankGradients — basic shape', () => {
  it('always returns exactly 5 axes', () => {
    const result = rankGradients({
      records: [],
      ledger: createEmptyLedger(24),
      profile: genericProfile,
      weights: DEFAULT_CR_EIG_WEIGHTS,
      cavMatrix: [],
      oracleAnchors: [],
      round: 3,
    })
    expect(result.length).toBe(5)
    const grads = result.map(r => r.gradient).sort()
    expect(grads).toEqual([...GRADIENT_IDS])
  })

  it('every entry has full RankedGradient shape with modelChose=false', () => {
    const result = rankGradients({
      records: [rec('A', 'foo'), rec('B', 'bar')],
      ledger: createEmptyLedger(24),
      profile: genericProfile,
      weights: DEFAULT_CR_EIG_WEIGHTS,
      cavMatrix: [],
      oracleAnchors: [],
      round: 3,
    })
    for (const r of result) {
      expect(typeof r.gradient).toBe('string')
      expect(typeof r.crEig).toBe('number')
      expect(typeof r.explanation).toBe('string')
      expect(r.explanation.length).toBeLessThanOrEqual(200)
      expect(r.modelChose).toBe(false)
      expect(r.breakdown).toBeDefined()
      expect(typeof r.breakdown.baseEig).toBe('number')
    }
  })
})

describe('rankGradients — sorting (R4-3)', () => {
  it('result is sorted by crEig descending', () => {
    const result = rankGradients({
      records: [rec('A', 'PE32+ executable')],
      ledger: createEmptyLedger(24),
      profile: genericProfile,
      weights: DEFAULT_CR_EIG_WEIGHTS,
      cavMatrix: [],
      oracleAnchors: [],
      round: 3,
    })
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1]!.crEig).toBeGreaterThanOrEqual(
        result[i]!.crEig - 1e-9,
      )
    }
  })

  it('all-zero score → lex-asc tie-break (gradient name)', () => {
    // Force every term to 0 via zero weights + empty inputs.
    const result = rankGradients({
      records: [],
      ledger: createEmptyLedger(24),
      profile: genericProfile,
      weights: {
        ...DEFAULT_CR_EIG_WEIGHTS,
        lambdaCost: 0,
        gammaCausal: 0,
        kappaUrgency: 0,
        gammaExplore: 0,
      },
      cavMatrix: [],
      oracleAnchors: [],
      round: 3,
    })
    // With all weights 0 + no records, every term is 0; tie-break should
    // sort by historical-use asc (all 0) → lex-asc on gradient name.
    expect(result[0]!.gradient).toBe('attack')
    expect(result[1]!.gradient).toBe('chain')
    expect(result[2]!.gradient).toBe('discretize')
    expect(result[3]!.gradient).toBe('oracle')
    expect(result[4]!.gradient).toBe('swap')
  })
})

describe('rankGradients — determinism (R4-5)', () => {
  it('two calls with identical inputs return identical crEig vectors', () => {
    const args = {
      records: [rec('A', 'PE32+ exec'), rec('B', 'ELF')],
      ledger: createEmptyLedger(24),
      profile: genericProfile,
      weights: DEFAULT_CR_EIG_WEIGHTS,
      cavMatrix: [],
      oracleAnchors: [],
      round: 3,
    }
    const a = rankGradients(args).map(x => x.crEig)
    const b = rankGradients(args).map(x => x.crEig)
    expect(a).toEqual(b)
  })
})

describe('rankGradients — generic cold-start (R4-6)', () => {
  it('round=0 with generic profile → oracle gradient sees +0.1 bump (visible in breakdown)', () => {
    const round0 = rankGradients({
      records: [],
      ledger: createEmptyLedger(24),
      profile: genericProfile,
      weights: DEFAULT_CR_EIG_WEIGHTS,
      cavMatrix: [],
      oracleAnchors: [],
      round: 0,
    })
    const round2 = rankGradients({
      records: [],
      ledger: createEmptyLedger(24),
      profile: genericProfile,
      weights: DEFAULT_CR_EIG_WEIGHTS,
      cavMatrix: [],
      oracleAnchors: [],
      round: 2,
    })
    const oracle0 = round0.find(r => r.gradient === 'oracle')!
    const oracle2 = round2.find(r => r.gradient === 'oracle')!
    expect(oracle0.breakdown.explorationBonus).toBeGreaterThanOrEqual(
      oracle2.breakdown.explorationBonus + 0.099,
    )
  })
})

describe('rankGradients — performance', () => {
  it('100 records pass within 200ms total', () => {
    const records: CavRecord[] = []
    for (let i = 0; i < 100; i++) {
      records.push(rec(`A${i % 4}`, `claim-${i}`, 'defend', 0.3, i))
    }
    const t0 = performance.now()
    rankGradients({
      records,
      ledger: createEmptyLedger(24),
      profile: genericProfile,
      weights: DEFAULT_CR_EIG_WEIGHTS,
      cavMatrix: [],
      oracleAnchors: [],
      round: 3,
    })
    const dt = performance.now() - t0
    expect(dt).toBeLessThan(200)
  })
})

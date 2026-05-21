/**
 * Plan Statistics — unit tests.
 */

import { describe, expect, test } from 'bun:test'
import { createEmptyLedger, appendEvidence, type SharedLedger } from '../ledger.js'
import { computePlanStats } from '../planStats.js'

function ledgerWithEvidence(
  entries: Array<{ toolName: string; verdict: 'confirms' | 'falsifies' | 'mutates' | 'inconclusive' }>,
): SharedLedger {
  let l = createEmptyLedger(24)
  for (const e of entries) {
    l = appendEvidence(l, {
      agentId: 'A',
      round: 0,
      toolName: e.toolName,
      toolArgs: {},
      outcome: 'success',
      resultDigest: '',
      testedHypothesis: 'H1',
      verdict: e.verdict,
      durationMs: 1,
    }).ledger
  }
  return l
}

describe('computePlanStats', () => {
  test('empty ledger → uniform prior (0.4/0.4/0.2)', () => {
    const l = createEmptyLedger(24)
    const stats = computePlanStats('packer::diec', l)
    expect(stats.confirmRate).toBeCloseTo(0.4, 5)
    expect(stats.falsifyRate).toBeCloseTo(0.4, 5)
    expect(stats.inconclusiveRate).toBeCloseTo(0.2, 5)
    expect(stats.sampleCount).toBe(0)
  })

  test('unknown plan id → uniform prior', () => {
    const l = createEmptyLedger(24)
    const stats = computePlanStats('does::not-exist', l)
    expect(stats.sampleCount).toBe(0)
    expect(stats.confirmRate).toBeCloseTo(0.4, 5)
  })

  test('3 confirms + 1 falsify (sampleCount ≥ 3) → no smoothing', () => {
    // packer::diec uses tool 'ReverseCli'
    const l = ledgerWithEvidence([
      { toolName: 'ReverseCli', verdict: 'confirms' },
      { toolName: 'ReverseCli', verdict: 'confirms' },
      { toolName: 'ReverseCli', verdict: 'confirms' },
      { toolName: 'ReverseCli', verdict: 'falsifies' },
    ])
    const stats = computePlanStats('packer::diec', l)
    expect(stats.sampleCount).toBe(4)
    expect(stats.confirmRate).toBeCloseTo(3 / 4, 5)
    expect(stats.falsifyRate).toBeCloseTo(1 / 4, 5)
    expect(stats.inconclusiveRate).toBeCloseTo(0, 5)
  })

  test('sampleCount < 3 → Laplace smoothing applied', () => {
    const l = ledgerWithEvidence([
      { toolName: 'ReverseCli', verdict: 'confirms' },
      { toolName: 'ReverseCli', verdict: 'confirms' },
    ])
    const stats = computePlanStats('packer::diec', l)
    expect(stats.sampleCount).toBe(2) // raw count
    // After smoothing: confirms=3, falsifies=1, inconclusives=0.5 → total=4.5
    expect(stats.confirmRate).toBeCloseTo(3 / 4.5, 4)
    expect(stats.falsifyRate).toBeCloseTo(1 / 4.5, 4)
    expect(stats.inconclusiveRate).toBeCloseTo(0.5 / 4.5, 4)
  })

  test('mutates verdict counts as inconclusive', () => {
    const l = ledgerWithEvidence([
      { toolName: 'ReverseCli', verdict: 'mutates' },
      { toolName: 'ReverseCli', verdict: 'mutates' },
      { toolName: 'ReverseCli', verdict: 'confirms' },
    ])
    const stats = computePlanStats('packer::diec', l)
    expect(stats.sampleCount).toBe(3)
    expect(stats.confirmRate).toBeCloseTo(1 / 3, 4)
    expect(stats.inconclusiveRate).toBeCloseTo(2 / 3, 4)
  })

  test('evidence from a different tool is ignored', () => {
    const l = ledgerWithEvidence([
      { toolName: 'Bash', verdict: 'confirms' },
      { toolName: 'Bash', verdict: 'confirms' },
      { toolName: 'Bash', verdict: 'confirms' },
    ])
    // packer::diec uses ReverseCli, not Bash
    const stats = computePlanStats('packer::diec', l)
    expect(stats.sampleCount).toBe(0)
    expect(stats.confirmRate).toBeCloseTo(0.4, 5)
  })

  test('pure function: same input → same output', () => {
    const l = ledgerWithEvidence([
      { toolName: 'ReverseCli', verdict: 'confirms' },
      { toolName: 'ReverseCli', verdict: 'falsifies' },
      { toolName: 'ReverseCli', verdict: 'confirms' },
    ])
    const r1 = computePlanStats('packer::diec', l)
    const r2 = computePlanStats('packer::diec', l)
    expect(r1).toEqual(r2)
  })

  test('rates always sum to ~1.0', () => {
    const l = ledgerWithEvidence([
      { toolName: 'ReverseCli', verdict: 'confirms' },
      { toolName: 'ReverseCli', verdict: 'falsifies' },
      { toolName: 'ReverseCli', verdict: 'inconclusive' },
      { toolName: 'ReverseCli', verdict: 'confirms' },
    ])
    const stats = computePlanStats('packer::diec', l)
    const sum = stats.confirmRate + stats.falsifyRate + stats.inconclusiveRate
    expect(sum).toBeCloseTo(1.0, 5)
  })
})

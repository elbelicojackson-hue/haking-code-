/**
 * T3 — costInBits unit tests.
 *
 * Asserts:
 *   - 4 buckets map to {0.05, 0.15, 0.4, 1.0}
 *   - unknown bucket throws (defence-in-depth)
 *   - 1000-call ULP=0 determinism (R7-7)
 */

import { describe, expect, it } from 'bun:test'
import { COST_IN_BITS_TABLE } from '../constants.js'
import { costInBits } from '../cost.js'
import type { ToolPlan } from '../types.js'

const MOCK_PLAN_BASE = {
  id: 'mock::a',
  kind: 'file-class',
  tool: 'ReverseCli',
  base_args: {},
  overridable_fields: [],
  confirms: [],
  falsifies: [],
  timeout_ms: 5000,
  description: 'mock',
} as const

const mockPlan = (cost: ToolPlan['cost_estimate']): ToolPlan => ({
  ...MOCK_PLAN_BASE,
  cost_estimate: cost,
} as unknown as ToolPlan)

describe('costInBits', () => {
  it.each([
    ['tiny', 0.05],
    ['small', 0.15],
    ['medium', 0.4],
    ['large', 1.0],
  ] as const)('%s bucket → %f bits', (bucket, expected) => {
    expect(costInBits(mockPlan(bucket))).toBe(expected)
  })

  it('throws on unknown cost_estimate (cast bypass)', () => {
    const bad = mockPlan('xxl' as unknown as ToolPlan['cost_estimate'])
    expect(() => costInBits(bad)).toThrow(/Unknown cost_estimate: xxl/)
  })

  it('throws on undefined cost_estimate', () => {
    const bad = { ...MOCK_PLAN_BASE } as unknown as ToolPlan
    expect(() => costInBits(bad)).toThrow(/Unknown cost_estimate/)
  })

  it('1000 calls return ULP=0 identical results (R7-7)', () => {
    const plan = mockPlan('medium')
    const first = costInBits(plan)
    for (let i = 0; i < 1000; i++) {
      expect(costInBits(plan)).toBe(first)
    }
  })

  it('costInBits values match the COST_IN_BITS_TABLE source of truth', () => {
    for (const [bucket, expected] of Object.entries(COST_IN_BITS_TABLE)) {
      expect(costInBits(mockPlan(bucket as ToolPlan['cost_estimate']))).toBe(
        expected,
      )
    }
  })
})

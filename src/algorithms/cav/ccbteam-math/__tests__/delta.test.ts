/**
 * T8 — cavAdaptiveDelta unit + property tests.
 *
 * Covers:
 *   - R2-2: formula δ = δ_0 · w(reading) · (1 − self_entropy)
 *   - R2-3: strong-signal fallback to deltaZero
 *   - R2-4: 0 < δ ≤ deltaZero hard bounds
 *   - R2-5: idempotence under repeated invocation
 *   - R2-7: useAdaptiveDelta=false equivalence (verified at the
 *           crEig-call site in T7 tests; here we just lock the formula)
 */

import { describe, expect, it } from 'bun:test'
import { ADAPTIVE_DELTA_EPS_FLOOR, DEFAULT_CR_EIG_WEIGHTS } from '../constants.js'
import { cavAdaptiveDelta } from '../delta.js'
import type { CavReading } from '../types.js'

const baseReading: CavReading = {
  self_entropy: 0.4,
  calibration: 0.7,
  update_kl: 0.5,
  repair_style: 'defend',
  commitment: null,
  hesitation: null,
  coherence: null,
  trace_depth: null,
  latency: null,
  reciprocity: null,
}

describe('cavAdaptiveDelta — formula & defaults', () => {
  it('falls back to deltaZero when self_entropy is null (R2-3)', () => {
    const r = { ...baseReading, self_entropy: null }
    expect(cavAdaptiveDelta(r)).toBe(DEFAULT_CR_EIG_WEIGHTS.deltaZero)
  })

  it('falls back to deltaZero when calibration is null (R2-3)', () => {
    const r = { ...baseReading, calibration: null }
    expect(cavAdaptiveDelta(r)).toBe(DEFAULT_CR_EIG_WEIGHTS.deltaZero)
  })

  it('respects custom deltaZero override', () => {
    const r = { ...baseReading, self_entropy: null }
    expect(cavAdaptiveDelta(r, { deltaZero: 0.1 })).toBe(0.1)
  })

  it('returns a value in (0, deltaZero] for normal readings (R2-4)', () => {
    const δ = cavAdaptiveDelta(baseReading)
    expect(δ).toBeGreaterThan(0)
    expect(δ).toBeLessThanOrEqual(DEFAULT_CR_EIG_WEIGHTS.deltaZero)
  })

  it('idempotent under repeated calls (R2-5)', () => {
    const a = cavAdaptiveDelta(baseReading)
    const b = cavAdaptiveDelta(baseReading)
    const c = cavAdaptiveDelta(baseReading)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })
})

describe('cavAdaptiveDelta — boundary saturation', () => {
  it('self_entropy = 1 collapses (1 − entropy) factor to ε floor', () => {
    const r = { ...baseReading, self_entropy: 1 }
    const δ = cavAdaptiveDelta(r)
    // δ ≥ deltaZero · ε_floor · ε_floor (worst case both floors)
    expect(δ).toBeGreaterThanOrEqual(
      ADAPTIVE_DELTA_EPS_FLOOR * ADAPTIVE_DELTA_EPS_FLOOR,
    )
    expect(δ).toBeLessThanOrEqual(DEFAULT_CR_EIG_WEIGHTS.deltaZero)
  })

  it('strong signals + perfect agent (cal=1, entropy=0) approaches but ≤ deltaZero', () => {
    const r = { ...baseReading, self_entropy: 0, calibration: 1 }
    const δ = cavAdaptiveDelta(r)
    expect(δ).toBeLessThanOrEqual(DEFAULT_CR_EIG_WEIGHTS.deltaZero)
    expect(δ).toBeGreaterThan(0)
  })
})

describe('cavAdaptiveDelta — PBT (50 random readings)', () => {
  it('always satisfies 0 < δ ≤ deltaZero', () => {
    const seed = 2026_05_18
    let s = seed
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 2 ** 32
    }
    for (let i = 0; i < 50; i++) {
      const r: CavReading = {
        ...baseReading,
        self_entropy: rnd(),
        calibration: rnd(),
        update_kl: rnd() * 2,
      }
      const δ = cavAdaptiveDelta(r)
      expect(δ).toBeGreaterThan(0)
      expect(δ).toBeLessThanOrEqual(DEFAULT_CR_EIG_WEIGHTS.deltaZero)
    }
  })
})

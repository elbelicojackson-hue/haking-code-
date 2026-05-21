/**
 * T17 — buildEpistemicHonestyBlock tests.
 *
 * Covers:
 *   - Output contains the `<epistemic>` JSON template skeleton
 *   - Output contains every [E1]..[E5] rule literally
 *   - Determinism (constant function)
 *   - Zero Math Layer keywords (R5-9 / R13)
 */

import { describe, expect, it } from 'bun:test'
import { buildEpistemicHonestyBlock } from '../epistemicBlock.js'
import { EPISTEMIC_HONESTY_RULES } from '../../ccbteam-math/constants.js'

const MATH_KEYWORD_RE = /(cr-?eig|exploitability|epsilon[-_]?n(?:ash)?e?|\brho_t\b|rankgradient|crEig)/i

describe('buildEpistemicHonestyBlock', () => {
  it('contains the canonical heading', () => {
    expect(buildEpistemicHonestyBlock()).toContain('## 认知边界纪律 (R13)')
  })

  it('contains the ```epistemic JSON template fence', () => {
    const text = buildEpistemicHonestyBlock()
    expect(text).toContain('```epistemic')
    expect(text).toContain('"knowledge_zone"')
    expect(text).toContain('"training_cutoff_aware"')
    expect(text).toContain('"oracle_used"')
    expect(text).toContain('"claim_grounded_in"')
    expect(text).toContain('"refusal_when_unknown"')
  })

  it('contains every [E#] rule body verbatim', () => {
    const text = buildEpistemicHonestyBlock()
    for (const r of EPISTEMIC_HONESTY_RULES) {
      // Ensure rule id appears in `[En]` form
      expect(text.includes(`[${r.id}]`)).toBe(true)
      // First 30 chars of rule body should appear in output
      const head = r.rule.slice(0, 30)
      expect(text.includes(head)).toBe(true)
    }
  })

  it('is deterministic across 1000 calls', () => {
    const first = buildEpistemicHonestyBlock()
    for (let i = 0; i < 1000; i++) {
      expect(buildEpistemicHonestyBlock()).toBe(first)
    }
  })

  it('contains no Math Layer keywords', () => {
    expect(MATH_KEYWORD_RE.test(buildEpistemicHonestyBlock())).toBe(false)
  })

  it('mentions the Zahavian §6.7 honest-signal analogy', () => {
    expect(buildEpistemicHonestyBlock()).toContain('Zahavian')
  })
})

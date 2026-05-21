/**
 * T16 — invocationGate tests.
 *
 * Covers:
 *   - R12-4: appendix length budget (≤ 800 chars)
 *   - R11-9: every gate-* id appears in output
 *   - R12-6 / R5-9: no Math Layer keywords leaked
 *   - Determinism (constant function)
 */

import { describe, expect, it } from 'bun:test'
import {
  applyInvocationGate,
  MAX_GATE_APPENDIX_BYTES,
  renderAntiPatternsSection,
  renderInvocationGateSection,
} from '../invocationGate.js'
import {
  INVOCATION_ANTI_PATTERNS,
  INVOCATION_GATE_PRECONDITIONS,
} from '../../ccbteam-math/constants.js'

const MATH_KEYWORD_RE = /(cr-?eig|exploitability|epsilon[-_]?n(?:ash)?e?|\brho_t\b|rankgradient|crEig)/i

describe('applyInvocationGate', () => {
  it('preserves the original helpText prefix verbatim', () => {
    const original = 'this is the original help reply'
    const out = applyInvocationGate(original)
    expect(out.startsWith(original)).toBe(true)
  })

  it('appendix length is within MAX_GATE_APPENDIX_BYTES', () => {
    const original = 'x'
    const out = applyInvocationGate(original)
    const appendixLength = out.length - original.length
    expect(appendixLength).toBeLessThanOrEqual(MAX_GATE_APPENDIX_BYTES)
  })

  it('contains every gate-* id (R11-9)', () => {
    const out = applyInvocationGate('h')
    for (const p of INVOCATION_GATE_PRECONDITIONS) {
      expect(out.includes(p.id)).toBe(true)
    }
  })

  it('contains every anti-pattern entry verbatim', () => {
    const out = applyInvocationGate('h')
    for (const a of INVOCATION_ANTI_PATTERNS) {
      expect(out.includes(a)).toBe(true)
    }
  })

  it('contains no Math Layer keywords (R5-9 / R12-6)', () => {
    const out = applyInvocationGate('h')
    expect(MATH_KEYWORD_RE.test(out)).toBe(false)
  })

  it('is deterministic for repeated calls with same input', () => {
    const input = 'foo'
    const a = applyInvocationGate(input)
    const b = applyInvocationGate(input)
    const c = applyInvocationGate(input)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })
})

describe('renderInvocationGateSection', () => {
  it('lists exactly 5 [gate-*] bullets', () => {
    const text = renderInvocationGateSection()
    const bullets = text
      .split('\n')
      .filter(line => line.startsWith('- [gate-'))
    expect(bullets.length).toBe(5)
  })

  it('starts with the canonical heading', () => {
    expect(renderInvocationGateSection().startsWith('## Invocation Gate')).toBe(
      true,
    )
  })
})

describe('renderAntiPatternsSection', () => {
  it('lists ≥ 6 bullets', () => {
    const bullets = renderAntiPatternsSection()
      .split('\n')
      .filter(line => line.startsWith('- '))
    expect(bullets.length).toBeGreaterThanOrEqual(6)
  })

  it('starts with the canonical heading', () => {
    expect(renderAntiPatternsSection().startsWith('## 反模式')).toBe(true)
  })
})

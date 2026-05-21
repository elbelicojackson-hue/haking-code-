/**
 * T18 — epistemicParser tests.
 *
 * Covers all 5 [E#] rules + parse failure paths (R13-4..R13-9).
 */

import { describe, expect, it } from 'bun:test'
import { parseAndCheckEpistemic } from '../epistemicParser.js'
import type { EpistemicVerdict } from '../../ccbteam-math/types.js'

const wrap = (verdict: Partial<EpistemicVerdict>, extraText = ''): string => {
  const json = JSON.stringify(verdict)
  return `## 1. content\n\nclaim text${extraText}\n\n\`\`\`epistemic\n${json}\n\`\`\`\n`
}

const baseVerdict: EpistemicVerdict = {
  knowledge_zone: 'core',
  training_cutoff_aware: '2025-04',
  oracle_used: null,
  claim_grounded_in: 'memory',
  refusal_when_unknown: false,
}

const noPrior = {
  wasFlaggedAsBoundaryViolation: false,
  agentId: 'A',
} as const

const flaggedPrior = {
  wasFlaggedAsBoundaryViolation: true,
  agentId: 'A',
} as const

describe('parseAndCheckEpistemic — happy paths', () => {
  it('valid block + no violations → verdict + empty violations', () => {
    const out = parseAndCheckEpistemic(wrap(baseVerdict), noPrior)
    expect(out.verdict).not.toBeNull()
    expect(out.verdict?.knowledge_zone).toBe('core')
    expect(out.violations.length).toBe(0)
  })

  it('outside zone with explicit refusal → no E1 violation', () => {
    const v: EpistemicVerdict = {
      ...baseVerdict,
      knowledge_zone: 'outside',
      refusal_when_unknown: true,
    }
    const out = parseAndCheckEpistemic(wrap(v), noPrior)
    expect(out.verdict?.knowledge_zone).toBe('outside')
    expect(out.violations.length).toBe(0)
  })

  it('outside zone with oracle_used → no E1 violation', () => {
    const v: EpistemicVerdict = {
      ...baseVerdict,
      knowledge_zone: 'outside',
      oracle_used: 'oracle:firecrawl-1',
      claim_grounded_in: 'oracle:firecrawl-1 hits arxiv',
    }
    const out = parseAndCheckEpistemic(wrap(v), noPrior)
    expect(out.violations.length).toBe(0)
  })
})

describe('parseAndCheckEpistemic — [E1] outside + no oracle + no refuse', () => {
  it('flags E1 when outside + null oracle + refusal=false', () => {
    const v: EpistemicVerdict = {
      ...baseVerdict,
      knowledge_zone: 'outside',
      oracle_used: null,
      refusal_when_unknown: false,
    }
    const out = parseAndCheckEpistemic(wrap(v), noPrior)
    const ids = out.violations.map(x => x.ruleId)
    expect(ids).toContain('E1')
  })
})

describe('parseAndCheckEpistemic — [E2] training_cutoff_aware regex', () => {
  it('rejects "2025-13" (invalid month) → verdict null', () => {
    const v = {
      ...baseVerdict,
      training_cutoff_aware: '2025-13',
    }
    const out = parseAndCheckEpistemic(wrap(v), noPrior)
    expect(out.verdict).toBeNull()
  })

  it('accepts "unknown"', () => {
    const v: EpistemicVerdict = {
      ...baseVerdict,
      training_cutoff_aware: 'unknown',
    }
    const out = parseAndCheckEpistemic(wrap(v), noPrior)
    expect(out.verdict?.training_cutoff_aware).toBe('unknown')
  })

  it('rejects "abc-def"', () => {
    const v = { ...baseVerdict, training_cutoff_aware: 'abc-def' }
    const out = parseAndCheckEpistemic(wrap(v), noPrior)
    expect(out.verdict).toBeNull()
  })
})

describe('parseAndCheckEpistemic — [E4] oracle reference consistency', () => {
  it('flags E4 when oracle_used is set but not referenced in claim_grounded_in', () => {
    const v: EpistemicVerdict = {
      ...baseVerdict,
      oracle_used: 'oracle:firecrawl-1',
      claim_grounded_in: 'memory only',
    }
    const out = parseAndCheckEpistemic(wrap(v), noPrior)
    const ids = out.violations.map(x => x.ruleId)
    expect(ids).toContain('E4')
  })

  it('passes when oracle_used reference appears in claim_grounded_in', () => {
    const v: EpistemicVerdict = {
      ...baseVerdict,
      oracle_used: 'oracle:firecrawl-1',
      claim_grounded_in: 'cited oracle:firecrawl-1 article',
    }
    const out = parseAndCheckEpistemic(wrap(v), noPrior)
    expect(out.violations.find(x => x.ruleId === 'E4')).toBeUndefined()
  })
})

describe('parseAndCheckEpistemic — [E5] boundary correction repair_style', () => {
  const cavBlock = (style: string) =>
    `\n\n\`\`\`cav\n${JSON.stringify({ repair_style: style })}\n\`\`\`\n`

  it('flags E5 when prior boundary violation but repair_style=defend', () => {
    const text = wrap(baseVerdict, cavBlock('defend'))
    const out = parseAndCheckEpistemic(text, flaggedPrior)
    const ids = out.violations.map(x => x.ruleId)
    expect(ids).toContain('E5')
  })

  it('passes when prior boundary violation and repair_style=concede', () => {
    const text = wrap(baseVerdict, cavBlock('concede'))
    const out = parseAndCheckEpistemic(text, flaggedPrior)
    const ids = out.violations.map(x => x.ruleId)
    expect(ids).not.toContain('E5')
  })

  it('passes when prior boundary violation and repair_style=split', () => {
    const text = wrap(baseVerdict, cavBlock('split'))
    const out = parseAndCheckEpistemic(text, flaggedPrior)
    const ids = out.violations.map(x => x.ruleId)
    expect(ids).not.toContain('E5')
  })

  it('does not check E5 when no prior flag', () => {
    const text = wrap(baseVerdict, cavBlock('defend'))
    const out = parseAndCheckEpistemic(text, noPrior)
    const ids = out.violations.map(x => x.ruleId)
    expect(ids).not.toContain('E5')
  })
})

describe('parseAndCheckEpistemic — failure paths (never throws)', () => {
  it('no `epistemic block → { null, [] }', () => {
    const out = parseAndCheckEpistemic('plain text', noPrior)
    expect(out.verdict).toBeNull()
    expect(out.violations.length).toBe(0)
  })

  it('malformed JSON → { null, [] }', () => {
    const text = '```epistemic\n{ this is not json\n```\n'
    const out = parseAndCheckEpistemic(text, noPrior)
    expect(out.verdict).toBeNull()
  })

  it('missing required field → { null, [] }', () => {
    const text = `\`\`\`epistemic\n${JSON.stringify({
      knowledge_zone: 'core',
      // missing other fields
    })}\n\`\`\`\n`
    const out = parseAndCheckEpistemic(text, noPrior)
    expect(out.verdict).toBeNull()
  })

  it('unknown knowledge_zone → { null, [] }', () => {
    const v = { ...baseVerdict, knowledge_zone: 'wat' }
    const out = parseAndCheckEpistemic(wrap(v as never), noPrior)
    expect(out.verdict).toBeNull()
  })

  it('extra fields → strict reject → { null, [] }', () => {
    const text = `\`\`\`epistemic\n${JSON.stringify({
      ...baseVerdict,
      extra_field: 'x',
    })}\n\`\`\`\n`
    const out = parseAndCheckEpistemic(text, noPrior)
    expect(out.verdict).toBeNull()
  })

  it('never throws on adversarial input (PBT 50)', () => {
    let s = 0xfacefeed >>> 0
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 2 ** 32
    }
    for (let i = 0; i < 50; i++) {
      const garbage = '`'.repeat(Math.floor(rnd() * 10)) + Math.random().toString(36)
      const out = parseAndCheckEpistemic(garbage, noPrior)
      expect(out.verdict === null || typeof out.verdict === 'object').toBe(true)
    }
  })
})

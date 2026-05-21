/**
 * PEV Output Protocol — unit + property-based tests.
 *
 * Coverage map (per task T1 DoD + requirements R12-1):
 *   - Unit: every {@link HypothesisUpdate.op} branch happy path
 *   - Unit: every {@link NextAction.kind} branch happy path
 *   - Unit: every branch sad path on missing required field
 *   - Unit: schema_version is literal '1.0' (rejects '1.0.0', 'v1.0')
 *   - Unit: HypothesisId regex bounds (depth ≤ 4)
 *   - Unit: strictObject rejects unknown root keys
 *   - PBT:  HypothesisId regex invariant (Property 3)
 *   - PBT:  HypothesisUpdate discriminator exclusivity (Property 2)
 *   - PBT:  NextAction discriminator completeness (Property 3 of R12-1)
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 2.1-2.7, 3.1-3.6, 14.3
 */

import { describe, expect, test } from 'bun:test'
import * as fc from 'fast-check'
import {
  EvidenceIdSchema,
  HypothesisIdSchema,
  HypothesisKindSchema,
  HypothesisUpdateSchema,
  NextActionSchema,
  ObservationSchema,
  PEV_SCHEMA_VERSION,
  PevOutputSchema,
  VerdictSchema,
} from '../protocol.js'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A minimal valid PevOutput skeleton — tests override one field at a time. */
const baseOutput = {
  schema_version: '1.0' as const,
  agent_id: 'static_analyst',
  round: 0,
  observations: [],
  hypothesis_updates: [],
  next_action: {
    kind: 'observe_only' as const,
    rationale: 'no signal yet',
  },
}

/* -------------------------------------------------------------------------- */
/* Schema-version literal (R1-4)                                              */
/* -------------------------------------------------------------------------- */

describe('PEV_SCHEMA_VERSION', () => {
  test('is the literal "1.0"', () => {
    expect(PEV_SCHEMA_VERSION).toBe('1.0')
  })

  test('PevOutputSchema accepts "1.0"', () => {
    expect(PevOutputSchema.safeParse(baseOutput).success).toBe(true)
  })

  test('PevOutputSchema rejects "1.0.0"', () => {
    const r = PevOutputSchema.safeParse({ ...baseOutput, schema_version: '1.0.0' })
    expect(r.success).toBe(false)
  })

  test('PevOutputSchema rejects "v1.0"', () => {
    const r = PevOutputSchema.safeParse({ ...baseOutput, schema_version: 'v1.0' })
    expect(r.success).toBe(false)
  })

  test('PevOutputSchema rejects 1.0 number', () => {
    const r = PevOutputSchema.safeParse({ ...baseOutput, schema_version: 1.0 })
    expect(r.success).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* HypothesisIdSchema regex (R2-7, R14-3)                                     */
/* -------------------------------------------------------------------------- */

describe('HypothesisIdSchema', () => {
  const valid = ['H1', 'H2', 'H10', 'H1.2', 'H1.2.3', 'H1.2.3.4']
  const invalid = [
    '',
    'H',
    'h1',
    'H1.',
    '.H1',
    'H1.2.3.4.5', // depth 5 — exceeds limit
    'H1.a',
    'H1..2',
    'H 1',
    '1',
  ]

  for (const id of valid) {
    test(`accepts "${id}"`, () => {
      expect(HypothesisIdSchema.safeParse(id).success).toBe(true)
    })
  }

  for (const id of invalid) {
    test(`rejects "${id}"`, () => {
      expect(HypothesisIdSchema.safeParse(id).success).toBe(false)
    })
  }
})

/* -------------------------------------------------------------------------- */
/* EvidenceIdSchema regex                                                     */
/* -------------------------------------------------------------------------- */

describe('EvidenceIdSchema', () => {
  test('accepts E1, E10, E999', () => {
    expect(EvidenceIdSchema.safeParse('E1').success).toBe(true)
    expect(EvidenceIdSchema.safeParse('E10').success).toBe(true)
    expect(EvidenceIdSchema.safeParse('E999').success).toBe(true)
  })

  test('rejects e1, E, E1.1, evidence-1', () => {
    expect(EvidenceIdSchema.safeParse('e1').success).toBe(false)
    expect(EvidenceIdSchema.safeParse('E').success).toBe(false)
    expect(EvidenceIdSchema.safeParse('E1.1').success).toBe(false)
    expect(EvidenceIdSchema.safeParse('evidence-1').success).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* HypothesisKindSchema enum (R-Glossary 8 类)                                */
/* -------------------------------------------------------------------------- */

describe('HypothesisKindSchema', () => {
  const expected = [
    'file-class',
    'packer',
    'compiler',
    'family',
    'algorithm',
    'anti-analysis',
    'capability',
    'protocol',
  ] as const

  for (const k of expected) {
    test(`accepts "${k}"`, () => {
      expect(HypothesisKindSchema.safeParse(k).success).toBe(true)
    })
  }

  test('rejects unknown kind', () => {
    expect(HypothesisKindSchema.safeParse('unknown').success).toBe(false)
    expect(HypothesisKindSchema.safeParse('').success).toBe(false)
    expect(HypothesisKindSchema.safeParse('PACKER').success).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* VerdictSchema enum (4 类)                                                  */
/* -------------------------------------------------------------------------- */

describe('VerdictSchema', () => {
  const expected = ['confirms', 'falsifies', 'mutates', 'inconclusive'] as const

  for (const v of expected) {
    test(`accepts "${v}"`, () => {
      expect(VerdictSchema.safeParse(v).success).toBe(true)
    })
  }

  test('rejects unknown verdict', () => {
    expect(VerdictSchema.safeParse('confirm').success).toBe(false) // missing 's'
    expect(VerdictSchema.safeParse('').success).toBe(false)
    expect(VerdictSchema.safeParse('CONFIRMS').success).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* ObservationSchema                                                          */
/* -------------------------------------------------------------------------- */

describe('ObservationSchema', () => {
  test('happy path', () => {
    const r = ObservationSchema.safeParse({
      evidence_id: 'E1',
      verdict: 'confirms',
      confidence: 0.85,
    })
    expect(r.success).toBe(true)
  })

  test('rejects confidence > 1', () => {
    const r = ObservationSchema.safeParse({
      evidence_id: 'E1',
      verdict: 'confirms',
      confidence: 1.1,
    })
    expect(r.success).toBe(false)
  })

  test('rejects confidence < 0', () => {
    const r = ObservationSchema.safeParse({
      evidence_id: 'E1',
      verdict: 'confirms',
      confidence: -0.01,
    })
    expect(r.success).toBe(false)
  })

  test('rejects unknown extra field (strictObject)', () => {
    const r = ObservationSchema.safeParse({
      evidence_id: 'E1',
      verdict: 'confirms',
      confidence: 0.5,
      extra: 'nope',
    })
    expect(r.success).toBe(false)
  })

  test('rejects missing verdict', () => {
    const r = ObservationSchema.safeParse({
      evidence_id: 'E1',
      confidence: 0.5,
    })
    expect(r.success).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* HypothesisUpdateSchema — every op branch (R2-1 ~ R2-7)                     */
/* -------------------------------------------------------------------------- */

describe('HypothesisUpdateSchema — op="create"', () => {
  test('happy path (no parent)', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'create',
      id: 'H1',
      kind: 'packer',
      text: 'PE32+ packed by UPX',
      confidence: 0.7,
    })
    expect(r.success).toBe(true)
  })

  test('happy path with parent', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'create',
      id: 'H1.1',
      parent_id: 'H1',
      kind: 'compiler',
      text: 'Inner payload is .NET',
      confidence: 0.5,
    })
    expect(r.success).toBe(true)
  })

  test('happy path with parent_id=null', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'create',
      id: 'H2',
      parent_id: null,
      kind: 'family',
      text: 'Suspected ransomware family',
      confidence: 0.3,
    })
    expect(r.success).toBe(true)
  })

  test('sad: missing kind', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'create',
      id: 'H1',
      text: 'no kind here',
      confidence: 0.5,
    })
    expect(r.success).toBe(false)
  })

  test('sad: text too short', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'create',
      id: 'H1',
      kind: 'packer',
      text: 'abc', // < 5 chars
      confidence: 0.5,
    })
    expect(r.success).toBe(false)
  })

  test('sad: confidence out of range', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'create',
      id: 'H1',
      kind: 'packer',
      text: 'hello world',
      confidence: 1.5,
    })
    expect(r.success).toBe(false)
  })
})

describe('HypothesisUpdateSchema — op="promote"', () => {
  test('happy path', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'promote',
      id: 'H1',
      rationale_short: 'E5 confirms UPX signature',
    })
    expect(r.success).toBe(true)
  })

  test('sad: missing rationale_short', () => {
    const r = HypothesisUpdateSchema.safeParse({ op: 'promote', id: 'H1' })
    expect(r.success).toBe(false)
  })

  test('sad: rationale_short too short', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'promote',
      id: 'H1',
      rationale_short: 'ok', // < 5 chars
    })
    expect(r.success).toBe(false)
  })
})

describe('HypothesisUpdateSchema — op="falsify"', () => {
  test('happy path', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'falsify',
      id: 'H3',
      counter_evidence_id: 'E7',
      rationale_short: 'No anti-debug strings present',
    })
    expect(r.success).toBe(true)
  })

  test('sad: missing counter_evidence_id', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'falsify',
      id: 'H3',
      rationale_short: 'no counter evidence here',
    })
    expect(r.success).toBe(false)
  })

  test('sad: bad counter_evidence_id format', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'falsify',
      id: 'H3',
      counter_evidence_id: 'evidence-7',
      rationale_short: 'wrong id format',
    })
    expect(r.success).toBe(false)
  })
})

describe('HypothesisUpdateSchema — op="mutate"', () => {
  test('happy path', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'mutate',
      id: 'H4',
      new_id: 'H4.1',
      text: 'Anti-debug lives in dynamic layer, not strings',
      confidence: 0.6,
      rationale_short: 'E5 inconclusive at strings layer',
    })
    expect(r.success).toBe(true)
  })

  test('sad: missing new_id', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'mutate',
      id: 'H4',
      text: 'a hypothesis text',
      confidence: 0.6,
      rationale_short: 'no new id field',
    })
    expect(r.success).toBe(false)
  })

  test('sad: bad new_id format', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'mutate',
      id: 'H4',
      new_id: 'h4.1', // lowercase
      text: 'a hypothesis text',
      confidence: 0.6,
      rationale_short: 'bad new id format',
    })
    expect(r.success).toBe(false)
  })
})

describe('HypothesisUpdateSchema — op="confidence_adjust"', () => {
  test('happy path', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'confidence_adjust',
      id: 'H1',
      new_confidence: 0.8,
      rationale_short: 'further evidence solidifies prior',
    })
    expect(r.success).toBe(true)
  })

  test('sad: missing new_confidence', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'confidence_adjust',
      id: 'H1',
      rationale_short: 'no new conf provided',
    })
    expect(r.success).toBe(false)
  })

  test('sad: new_confidence > 1', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'confidence_adjust',
      id: 'H1',
      new_confidence: 1.5,
      rationale_short: 'out of range value',
    })
    expect(r.success).toBe(false)
  })
})

describe('HypothesisUpdateSchema — discriminator', () => {
  test('rejects unknown op', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'delete',
      id: 'H1',
    })
    expect(r.success).toBe(false)
  })

  test('rejects missing op (no discriminator)', () => {
    const r = HypothesisUpdateSchema.safeParse({
      id: 'H1',
      kind: 'packer',
      text: 'hello world',
      confidence: 0.5,
    })
    expect(r.success).toBe(false)
  })

  test('strictObject rejects unknown extra field', () => {
    const r = HypothesisUpdateSchema.safeParse({
      op: 'promote',
      id: 'H1',
      rationale_short: 'something happened',
      extra: 'nope',
    })
    expect(r.success).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* NextActionSchema — every kind branch (R3-1 ~ R3-6)                         */
/* -------------------------------------------------------------------------- */

describe('NextActionSchema — kind="tool_call"', () => {
  test('happy path with args_override=null', () => {
    const r = NextActionSchema.safeParse({
      kind: 'tool_call',
      hypothesis_id: 'H1',
      tool_plan_id: 'packer::diec',
      args_override: null,
    })
    expect(r.success).toBe(true)
  })

  test('happy path with args_override object', () => {
    const r = NextActionSchema.safeParse({
      kind: 'tool_call',
      hypothesis_id: 'H1.2',
      tool_plan_id: 'algorithm::ida-script-dump',
      args_override: { timeout_ms: 60000 },
    })
    expect(r.success).toBe(true)
  })

  test('sad: missing args_override', () => {
    const r = NextActionSchema.safeParse({
      kind: 'tool_call',
      hypothesis_id: 'H1',
      tool_plan_id: 'packer::diec',
    })
    expect(r.success).toBe(false)
  })

  test('sad: bad tool_plan_id format', () => {
    const r = NextActionSchema.safeParse({
      kind: 'tool_call',
      hypothesis_id: 'H1',
      tool_plan_id: 'PACKER::diec', // uppercase
      args_override: null,
    })
    expect(r.success).toBe(false)
  })

  test('sad: tool_plan_id missing double colon', () => {
    const r = NextActionSchema.safeParse({
      kind: 'tool_call',
      hypothesis_id: 'H1',
      tool_plan_id: 'packer-diec',
      args_override: null,
    })
    expect(r.success).toBe(false)
  })
})

describe('NextActionSchema — kind="observe_only"', () => {
  test('happy path', () => {
    const r = NextActionSchema.safeParse({
      kind: 'observe_only',
      rationale: 'waiting for cross-agent evidence',
    })
    expect(r.success).toBe(true)
  })

  test('sad: missing rationale', () => {
    const r = NextActionSchema.safeParse({ kind: 'observe_only' })
    expect(r.success).toBe(false)
  })

  test('sad: rationale too short', () => {
    const r = NextActionSchema.safeParse({
      kind: 'observe_only',
      rationale: 'ok', // < 5
    })
    expect(r.success).toBe(false)
  })
})

describe('NextActionSchema — kind="request_oracle"', () => {
  test('happy path', () => {
    const r = NextActionSchema.safeParse({
      kind: 'request_oracle',
      query: 'UPX 4.0 NRV brute mode signature',
      rationale: 'need vendor confirmation',
    })
    expect(r.success).toBe(true)
  })

  test('sad: missing query', () => {
    const r = NextActionSchema.safeParse({
      kind: 'request_oracle',
      rationale: 'no query supplied',
    })
    expect(r.success).toBe(false)
  })

  test('sad: query too short', () => {
    const r = NextActionSchema.safeParse({
      kind: 'request_oracle',
      query: 'ab', // < 3
      rationale: 'too short',
    })
    expect(r.success).toBe(false)
  })
})

describe('NextActionSchema — kind="declare_done"', () => {
  test('happy path', () => {
    const r = NextActionSchema.safeParse({
      kind: 'declare_done',
      rationale: 'no further plan available for my owned H',
    })
    expect(r.success).toBe(true)
  })

  test('sad: missing rationale', () => {
    const r = NextActionSchema.safeParse({ kind: 'declare_done' })
    expect(r.success).toBe(false)
  })
})

describe('NextActionSchema — discriminator', () => {
  test('rejects unknown kind', () => {
    const r = NextActionSchema.safeParse({
      kind: 'await_user',
      rationale: 'this kind does not exist',
    })
    expect(r.success).toBe(false)
  })

  test('rejects type discriminator instead of kind (R3-6)', () => {
    const r = NextActionSchema.safeParse({
      type: 'observe_only',
      rationale: 'wrong discriminator name',
    })
    expect(r.success).toBe(false)
  })

  test('rejects action discriminator instead of kind (R3-6)', () => {
    const r = NextActionSchema.safeParse({
      action: 'declare_done',
      rationale: 'wrong discriminator name',
    })
    expect(r.success).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* PevOutputSchema top-level                                                  */
/* -------------------------------------------------------------------------- */

describe('PevOutputSchema (top-level)', () => {
  test('happy: minimal observe-only output', () => {
    expect(PevOutputSchema.safeParse(baseOutput).success).toBe(true)
  })

  test('happy: full output with observations + updates + tool_call', () => {
    const r = PevOutputSchema.safeParse({
      schema_version: '1.0',
      agent_id: 'static_analyst',
      round: 3,
      observations: [
        { evidence_id: 'E5', verdict: 'confirms', confidence: 0.85 },
      ],
      hypothesis_updates: [
        { op: 'promote', id: 'H1', rationale_short: 'E5 confirms UPX signature' },
      ],
      next_action: {
        kind: 'tool_call',
        hypothesis_id: 'H1.1',
        tool_plan_id: 'compiler::dnspy-probe',
        args_override: null,
      },
    })
    expect(r.success).toBe(true)
  })

  test('sad: missing schema_version', () => {
    const { schema_version: _, ...rest } = baseOutput
    expect(PevOutputSchema.safeParse(rest).success).toBe(false)
  })

  test('sad: missing agent_id', () => {
    const { agent_id: _, ...rest } = baseOutput
    expect(PevOutputSchema.safeParse(rest).success).toBe(false)
  })

  test('sad: missing round', () => {
    const { round: _, ...rest } = baseOutput
    expect(PevOutputSchema.safeParse(rest).success).toBe(false)
  })

  test('sad: missing next_action', () => {
    const { next_action: _, ...rest } = baseOutput
    expect(PevOutputSchema.safeParse(rest).success).toBe(false)
  })

  test('sad: round is float', () => {
    expect(
      PevOutputSchema.safeParse({ ...baseOutput, round: 1.5 }).success,
    ).toBe(false)
  })

  test('sad: round is negative', () => {
    expect(
      PevOutputSchema.safeParse({ ...baseOutput, round: -1 }).success,
    ).toBe(false)
  })

  test('sad: agent_id empty string', () => {
    expect(
      PevOutputSchema.safeParse({ ...baseOutput, agent_id: '' }).success,
    ).toBe(false)
  })

  test('sad: observations array > 8', () => {
    const tooMany = Array.from({ length: 9 }, (_, i) => ({
      evidence_id: `E${i + 1}`,
      verdict: 'confirms' as const,
      confidence: 0.5,
    }))
    expect(
      PevOutputSchema.safeParse({ ...baseOutput, observations: tooMany })
        .success,
    ).toBe(false)
  })

  test('sad: hypothesis_updates array > 8', () => {
    const tooMany = Array.from({ length: 9 }, (_, i) => ({
      op: 'promote' as const,
      id: `H${i + 1}`,
      rationale_short: `reason for H${i + 1}`,
    }))
    expect(
      PevOutputSchema.safeParse({
        ...baseOutput,
        hypothesis_updates: tooMany,
      }).success,
    ).toBe(false)
  })

  test('sad: unknown root key (strictObject)', () => {
    expect(
      PevOutputSchema.safeParse({ ...baseOutput, surprise: 'extra' }).success,
    ).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* Property-Based Tests (fast-check, numRuns ≤ 200 per R12-8)                 */
/* -------------------------------------------------------------------------- */

/**
 * Property 1 (R12-1 schema_version literal):
 * For ANY string s ≠ '1.0', PevOutputSchema rejects it.
 *
 * Validates: Requirements 1.4
 */
describe('PBT — Property 1: schema_version literal', () => {
  test('any string except "1.0" is rejected', () => {
    fc.assert(
      fc.property(
        fc.string().filter(s => s !== '1.0'),
        s => {
          const r = PevOutputSchema.safeParse({
            ...baseOutput,
            schema_version: s,
          })
          return r.success === false
        },
      ),
      { numRuns: 200 },
    )
  })
})

/**
 * Property 3 (R12-1, design Property 3):
 * HypothesisIdSchema accepts iff the string matches `^H\d+(\.\d+){0,3}$`.
 *
 * Both directions:
 *   (a) any string matching the regex → safeParse succeeds
 *   (b) any string NOT matching the regex → safeParse fails
 *
 * Validates: Requirements 2.7, 14.3
 */
describe('PBT — Property 3: HypothesisId regex invariant', () => {
  /** Generator that yields valid HypothesisIds at random depth 1..4. */
  const validHypothesisIdArb = fc
    .array(fc.integer({ min: 0, max: 999 }), { minLength: 0, maxLength: 3 })
    .chain(tail =>
      fc
        .integer({ min: 0, max: 999 })
        .map(head => 'H' + [head, ...tail].join('.')),
    )

  test('every regex-matching string is accepted', () => {
    fc.assert(
      fc.property(validHypothesisIdArb, id => {
        return HypothesisIdSchema.safeParse(id).success === true
      }),
      { numRuns: 200 },
    )
  })

  test('every non-matching string is rejected (forward direction)', () => {
    const re = /^H\d+(\.\d+){0,3}$/
    fc.assert(
      fc.property(
        fc.string().filter(s => !re.test(s)),
        s => HypothesisIdSchema.safeParse(s).success === false,
      ),
      { numRuns: 200 },
    )
  })

  test('depth >= 5 always rejected', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 99 }), {
          minLength: 5,
          maxLength: 8,
        }),
        nums => {
          const id = 'H' + nums.join('.')
          return HypothesisIdSchema.safeParse(id).success === false
        },
      ),
      { numRuns: 100 },
    )
  })
})

/**
 * Property 2 (R12-1 / design Property 2):
 * HypothesisUpdate discriminator exclusivity — for each op X, an object
 * tagged with op=X that satisfies branch X's required fields is accepted;
 * the SAME payload with op set to a different op Y is rejected (because
 * it is missing branch Y's required fields).
 *
 * This is the "exclusivity" property: branches don't accidentally overlap.
 *
 * Validates: Requirements 2.1-2.5
 */
describe('PBT — Property 2: HypothesisUpdate discriminator exclusivity', () => {
  // Sample valid payloads for each op. Each payload is structured so the
  // OWN op makes it valid; swapping to any other op should fail because
  // each branch requires a different unique-required-field set.
  const samples = {
    create: {
      op: 'create',
      id: 'H1',
      kind: 'packer',
      text: 'Sample hypothesis text long enough',
      confidence: 0.5,
    },
    promote: {
      op: 'promote',
      id: 'H1',
      rationale_short: 'sample rationale here',
    },
    falsify: {
      op: 'falsify',
      id: 'H1',
      counter_evidence_id: 'E1',
      rationale_short: 'sample rationale here',
    },
    mutate: {
      op: 'mutate',
      id: 'H1',
      new_id: 'H1.1',
      text: 'Sample mutation text long enough',
      confidence: 0.5,
      rationale_short: 'sample rationale here',
    },
    confidence_adjust: {
      op: 'confidence_adjust',
      id: 'H1',
      new_confidence: 0.8,
      rationale_short: 'sample rationale here',
    },
  } as const

  const ops = Object.keys(samples) as Array<keyof typeof samples>

  test('each sample is valid under its own op', () => {
    for (const op of ops) {
      const r = HypothesisUpdateSchema.safeParse(samples[op])
      expect(r.success).toBe(true)
    }
  })

  test('swapping to another op invalidates the payload (strictObject)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ops),
        fc.constantFrom(...ops),
        (origOp, newOp) => {
          // Skip self-swap
          if (origOp === newOp) return true
          const swapped = { ...samples[origOp], op: newOp }
          // strictObject + branch mismatch → rejection
          return HypothesisUpdateSchema.safeParse(swapped).success === false
        },
      ),
      { numRuns: 200 },
    )
  })

  test('any string not in the 5 ops is rejected', () => {
    fc.assert(
      fc.property(
        fc.string().filter(s => !ops.includes(s as never)),
        op => {
          const payload = { ...samples.promote, op }
          return HypothesisUpdateSchema.safeParse(payload).success === false
        },
      ),
      { numRuns: 200 },
    )
  })
})

/**
 * Property 4 (R12-1 NextAction completeness):
 * For each kind X, the minimal valid payload is accepted. For any string
 * not in the 4 kinds, the payload is rejected.
 *
 * Validates: Requirements 3.1-3.6
 */
describe('PBT — Property 4: NextAction discriminator completeness', () => {
  const samples = {
    tool_call: {
      kind: 'tool_call',
      hypothesis_id: 'H1',
      tool_plan_id: 'packer::diec',
      args_override: null,
    },
    observe_only: {
      kind: 'observe_only',
      rationale: 'sample rationale',
    },
    request_oracle: {
      kind: 'request_oracle',
      query: 'sample',
      rationale: 'sample rationale',
    },
    declare_done: {
      kind: 'declare_done',
      rationale: 'sample rationale',
    },
  } as const

  const kinds = Object.keys(samples) as Array<keyof typeof samples>

  test('each kind sample is valid', () => {
    for (const k of kinds) {
      expect(NextActionSchema.safeParse(samples[k]).success).toBe(true)
    }
  })

  test('any string not in the 4 kinds is rejected', () => {
    fc.assert(
      fc.property(
        fc.string().filter(s => !kinds.includes(s as never)),
        kind => {
          const payload = { ...samples.observe_only, kind }
          return NextActionSchema.safeParse(payload).success === false
        },
      ),
      { numRuns: 200 },
    )
  })
})

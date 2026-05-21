/**
 * PEV Validator — unit tests.
 *
 * Coverage map (per task T2 DoD):
 *   - One positive (`ok: true`) example per legal op + per next_action kind.
 *   - One negative example per `ParseErrorKind` the validator can emit:
 *       identity-mismatch, round-mismatch, unknown-evidence,
 *       unknown-hypothesis, unknown-parent, id-collision,
 *       illegal-promote, illegal-on-stale, self-contradiction,
 *       invalid-confidence-jump, unknown-tool-plan, invalid-args-override,
 *       illegal-tool-call.
 *   - Boundary cases:
 *       * empty hypothesis_updates array → ok
 *       * empty ledger + 'create' op → ok
 *       * empty ledger + 'promote' any id → fail
 *       * confidence_adjust delta == 0.5 → ok (boundary)
 *       * confidence_adjust delta == 0.5 + 1e-6 → fail
 *       * stale-resurrect via confidence_adjust ≥ 0.5 → ok
 *       * stale-resurrect via confidence_adjust < 0.5 → illegal-on-stale
 *       * findToolPlan absent → tool_plan / args_override checks skipped
 *
 * Validates: Requirements 1.5, 1.6, 2.1, 2.3, 2.6, 3.1, 3.2, 4.7, 7.9
 */

import { describe, expect, test } from 'bun:test'
import type { PevOutput } from '../protocol.js'
import {
  type LedgerView,
  type ValidatorContext,
  validatePevOutput,
} from '../validator.js'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

type HypothesisRecord = {
  id: string
  status: 'open' | 'evidence' | 'falsified' | 'mutated' | 'stale'
  confidence: number
}

/** Build a {@link LedgerView} from plain objects for terse test setup. */
function makeLedger(args: {
  hypotheses?: ReadonlyArray<HypothesisRecord>
  evidenceIds?: ReadonlyArray<string>
}): LedgerView {
  const hypMap = new Map<string, HypothesisRecord>()
  for (const h of args.hypotheses ?? []) hypMap.set(h.id, h)
  const evidenceLog = (args.evidenceIds ?? []).map(id => ({ id }))
  return { hypotheses: hypMap, evidenceLog }
}

/** Build a ValidatorContext with sensible defaults. */
function makeCtx(overrides: Partial<ValidatorContext> = {}): ValidatorContext {
  return {
    selfAgentId: 'static_analyst',
    round: 0,
    ledger: makeLedger({}),
    ...overrides,
  }
}

/** Build a minimal observe-only PevOutput (zod-valid). */
function makeOutput(overrides: Partial<PevOutput> = {}): PevOutput {
  return {
    schema_version: '1.0',
    agent_id: 'static_analyst',
    round: 0,
    observations: [],
    hypothesis_updates: [],
    next_action: { kind: 'observe_only', rationale: 'no signal yet' },
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/* Happy paths                                                                */
/* -------------------------------------------------------------------------- */

describe('validatePevOutput — happy paths', () => {
  test('empty hypothesis_updates + observe_only + empty ledger → ok', () => {
    const r = validatePevOutput(makeOutput(), makeCtx())
    expect(r.ok).toBe(true)
  })

  test("'create' op with empty ledger → ok", () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'create',
          id: 'H1',
          kind: 'packer',
          text: 'PE32+ packed by UPX',
          confidence: 0.7,
        },
      ],
    })
    const r = validatePevOutput(out, makeCtx())
    expect(r.ok).toBe(true)
  })

  test("'create' with parent_id pointing at existing H → ok", () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'create',
          id: 'H1.1',
          parent_id: 'H1',
          kind: 'compiler',
          text: 'Inner payload is .NET',
          confidence: 0.5,
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'evidence', confidence: 0.9 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(true)
  })

  test("'create' with parent_id=null → ok (treated as no parent)", () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'create',
          id: 'H2',
          parent_id: null,
          kind: 'family',
          text: 'Suspected ransomware family',
          confidence: 0.3,
        },
      ],
    })
    const r = validatePevOutput(out, makeCtx())
    expect(r.ok).toBe(true)
  })

  test("'promote' of an open H → ok", () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'promote',
          id: 'H1',
          rationale_short: 'E1 confirms claim',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'open', confidence: 0.6 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(true)
  })

  test("'falsify' with valid counter_evidence_id → ok", () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'falsify',
          id: 'H1',
          counter_evidence_id: 'E1',
          rationale_short: 'E1 contradicts H1',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'open', confidence: 0.6 }],
        evidenceIds: ['E1'],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(true)
  })

  test("'mutate' with new_id not in ledger → ok", () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'mutate',
          id: 'H1',
          new_id: 'H1.1',
          text: 'Refined hypothesis text',
          confidence: 0.5,
          rationale_short: 'mutation rationale',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'open', confidence: 0.5 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(true)
  })

  test("'confidence_adjust' within ±0.5 → ok", () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'confidence_adjust',
          id: 'H1',
          new_confidence: 0.7,
          rationale_short: 'reinforced confidence',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'open', confidence: 0.4 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(true)
  })

  test("'confidence_adjust' delta == 0.5 exactly → ok (boundary)", () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'confidence_adjust',
          id: 'H1',
          new_confidence: 0.7,
          rationale_short: 'boundary delta',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'open', confidence: 0.2 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(true)
  })

  test('observation referencing existing evidence_id → ok', () => {
    const out = makeOutput({
      observations: [
        { evidence_id: 'E1', verdict: 'confirms', confidence: 0.9 },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({ evidenceIds: ['E1', 'E2'] }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(true)
  })

  test('tool_call against an open H without findToolPlan → ok (lookup skipped)', () => {
    const out = makeOutput({
      next_action: {
        kind: 'tool_call',
        hypothesis_id: 'H1',
        tool_plan_id: 'packer::diec',
        args_override: null,
      },
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'open', confidence: 0.5 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(true)
  })

  test('tool_call with valid plan + args_override subset → ok', () => {
    const out = makeOutput({
      next_action: {
        kind: 'tool_call',
        hypothesis_id: 'H1',
        tool_plan_id: 'packer::diec',
        args_override: { diecArgs: ['-e', '-r'] },
      },
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'evidence', confidence: 0.8 }],
      }),
      findToolPlan: id =>
        id === 'packer::diec'
          ? { overridable_fields: ['targetPath', 'diecArgs'] }
          : undefined,
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(true)
  })

  test('tool_call with empty args_override object + plan defined → ok', () => {
    const out = makeOutput({
      next_action: {
        kind: 'tool_call',
        hypothesis_id: 'H1',
        tool_plan_id: 'packer::diec',
        args_override: {},
      },
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'open', confidence: 0.5 }],
      }),
      findToolPlan: () => ({ overridable_fields: [] }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Negative paths — every ParseErrorKind                                      */
/* -------------------------------------------------------------------------- */

describe('validatePevOutput — identity-mismatch (R1-5)', () => {
  test('agent_id != selfAgentId', () => {
    const r = validatePevOutput(
      makeOutput({ agent_id: 'binary_explorer' }),
      makeCtx({ selfAgentId: 'static_analyst' }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('identity-mismatch')
  })
})

describe('validatePevOutput — round-mismatch (R1-6)', () => {
  test('round != ctx.round', () => {
    const r = validatePevOutput(
      makeOutput({ round: 3 }),
      makeCtx({ round: 0 }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('round-mismatch')
  })
})

describe('validatePevOutput — unknown-evidence', () => {
  test('observation references E5 but ledger has only E1, E2', () => {
    const out = makeOutput({
      observations: [
        { evidence_id: 'E5', verdict: 'confirms', confidence: 0.9 },
      ],
    })
    const ctx = makeCtx({ ledger: makeLedger({ evidenceIds: ['E1', 'E2'] }) })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('unknown-evidence')
  })

  test('falsify references unknown counter_evidence_id', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'falsify',
          id: 'H1',
          counter_evidence_id: 'E99',
          rationale_short: 'no such evidence',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'open', confidence: 0.5 }],
        evidenceIds: ['E1'],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('unknown-evidence')
  })
})

describe('validatePevOutput — unknown-parent (R2-1)', () => {
  test("'create' with non-existent parent_id", () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'create',
          id: 'H1.1',
          parent_id: 'H99',
          kind: 'compiler',
          text: 'Some text long enough',
          confidence: 0.4,
        },
      ],
    })
    const r = validatePevOutput(out, makeCtx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('unknown-parent')
  })
})

describe('validatePevOutput — id-collision (R2-1, R2-4)', () => {
  test("'create' an id that already exists", () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'create',
          id: 'H1',
          kind: 'packer',
          text: 'duplicate id text',
          confidence: 0.5,
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'open', confidence: 0.4 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('id-collision')
  })

  test("'mutate' with new_id colliding with existing H", () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'mutate',
          id: 'H1',
          new_id: 'H2',
          text: 'collision text',
          confidence: 0.5,
          rationale_short: 'mutation rationale',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [
          { id: 'H1', status: 'open', confidence: 0.5 },
          { id: 'H2', status: 'open', confidence: 0.5 },
        ],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('id-collision')
  })
})

describe('validatePevOutput — illegal-promote (R2-2)', () => {
  test('promote a non-existent H', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'promote',
          id: 'H99',
          rationale_short: 'no such H',
        },
      ],
    })
    const r = validatePevOutput(out, makeCtx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('illegal-promote')
  })

  test('promote an H whose status is already evidence', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'promote',
          id: 'H1',
          rationale_short: 'already promoted',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'evidence', confidence: 0.9 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('illegal-promote')
  })

  test('promote a falsified H', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'promote',
          id: 'H1',
          rationale_short: 'cannot promote falsified',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'falsified', confidence: 0 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('illegal-promote')
  })

  test('boundary: empty ledger + promote any id → fail', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'promote',
          id: 'H1',
          rationale_short: 'no hypotheses anywhere',
        },
      ],
    })
    const r = validatePevOutput(out, makeCtx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('illegal-promote')
  })
})

describe('validatePevOutput — illegal-on-stale (R7-9)', () => {
  test('promote a stale H', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'promote',
          id: 'H1',
          rationale_short: 'cannot promote stale',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'stale', confidence: 0.3 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('illegal-on-stale')
  })

  test('mutate a stale H', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'mutate',
          id: 'H1',
          new_id: 'H1.1',
          text: 'cannot mutate stale text',
          confidence: 0.5,
          rationale_short: 'rationale',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'stale', confidence: 0.3 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('illegal-on-stale')
  })

  test('falsify a stale H', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'falsify',
          id: 'H1',
          counter_evidence_id: 'E1',
          rationale_short: 'cannot falsify stale',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'stale', confidence: 0.3 }],
        evidenceIds: ['E1'],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('illegal-on-stale')
  })

  test('confidence_adjust on stale with new_confidence < 0.5 fails', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'confidence_adjust',
          id: 'H1',
          new_confidence: 0.3,
          rationale_short: 'too weak to revive',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'stale', confidence: 0.3 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('illegal-on-stale')
  })

  test('confidence_adjust on stale with new_confidence ≥ 0.5 → ok (resurrect)', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'confidence_adjust',
          id: 'H1',
          new_confidence: 0.6,
          rationale_short: 'resurrect path',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'stale', confidence: 0.3 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(true)
  })

  test('tool_call targeting a stale H', () => {
    const out = makeOutput({
      next_action: {
        kind: 'tool_call',
        hypothesis_id: 'H1',
        tool_plan_id: 'packer::diec',
        args_override: null,
      },
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'stale', confidence: 0.3 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('illegal-on-stale')
  })
})

describe('validatePevOutput — self-contradiction (R2-6)', () => {
  test('promote and falsify in the same array for the same id', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'promote',
          id: 'H1',
          rationale_short: 'first promote',
        },
        {
          op: 'falsify',
          id: 'H1',
          counter_evidence_id: 'E1',
          rationale_short: 'then falsify same id',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'open', confidence: 0.5 }],
        evidenceIds: ['E1'],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('self-contradiction')
  })

  test('promote H1 + falsify H2 in same array → no contradiction', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'promote',
          id: 'H1',
          rationale_short: 'promote H1',
        },
        {
          op: 'falsify',
          id: 'H2',
          counter_evidence_id: 'E1',
          rationale_short: 'falsify H2',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [
          { id: 'H1', status: 'open', confidence: 0.5 },
          { id: 'H2', status: 'open', confidence: 0.5 },
        ],
        evidenceIds: ['E1'],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(true)
  })
})

describe('validatePevOutput — invalid-confidence-jump (R2-5)', () => {
  test('delta > 0.5 fails', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'confidence_adjust',
          id: 'H1',
          new_confidence: 0.95,
          rationale_short: 'too big a jump',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'open', confidence: 0.1 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('invalid-confidence-jump')
  })

  test('boundary: delta just over 0.5 fails', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'confidence_adjust',
          id: 'H1',
          new_confidence: 0.700001,
          rationale_short: 'just over boundary',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'open', confidence: 0.2 }],
      }),
    })
    // 0.700001 - 0.2 = 0.500001 > 0.5, but still within fp epsilon
    // tolerance? validator uses 1e-9. 0.500001 - 0.5 = 1e-6 > 1e-9.
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('invalid-confidence-jump')
  })
})

describe('validatePevOutput — unknown-hypothesis', () => {
  test('falsify of an id absent from ledger', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'falsify',
          id: 'H99',
          counter_evidence_id: 'E1',
          rationale_short: 'no such H',
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({ evidenceIds: ['E1'] }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('unknown-hypothesis')
  })

  test('mutate of an id absent from ledger', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'mutate',
          id: 'H99',
          new_id: 'H99.1',
          text: 'unknown id mutation',
          confidence: 0.5,
          rationale_short: 'rationale',
        },
      ],
    })
    const r = validatePevOutput(out, makeCtx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('unknown-hypothesis')
  })

  test('confidence_adjust of an id absent from ledger', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'confidence_adjust',
          id: 'H99',
          new_confidence: 0.5,
          rationale_short: 'rationale',
        },
      ],
    })
    const r = validatePevOutput(out, makeCtx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('unknown-hypothesis')
  })
})

describe('validatePevOutput — unknown-tool-plan (R3-1)', () => {
  test('tool_plan_id not present in plan table', () => {
    const out = makeOutput({
      next_action: {
        kind: 'tool_call',
        hypothesis_id: 'H1',
        tool_plan_id: 'packer::no-such-plan',
        args_override: null,
      },
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'open', confidence: 0.5 }],
      }),
      findToolPlan: () => undefined, // every lookup misses
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('unknown-tool-plan')
  })
})

describe('validatePevOutput — invalid-args-override (R3-2, R4-7)', () => {
  test('args_override key not in overridable_fields', () => {
    const out = makeOutput({
      next_action: {
        kind: 'tool_call',
        hypothesis_id: 'H1',
        tool_plan_id: 'packer::diec',
        args_override: { tool: 'Bash' }, // not allowed
      },
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'open', confidence: 0.5 }],
      }),
      findToolPlan: () => ({ overridable_fields: ['targetPath', 'diecArgs'] }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('invalid-args-override')
  })

  test('plan with empty overridable_fields rejects any non-empty override', () => {
    const out = makeOutput({
      next_action: {
        kind: 'tool_call',
        hypothesis_id: 'H1',
        tool_plan_id: 'packer::diec',
        args_override: { anything: 1 },
      },
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'open', confidence: 0.5 }],
      }),
      findToolPlan: () => ({ overridable_fields: [] }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('invalid-args-override')
  })
})

describe('validatePevOutput — illegal-tool-call (R3-1)', () => {
  test('tool_call hypothesis_id not in ledger', () => {
    const out = makeOutput({
      next_action: {
        kind: 'tool_call',
        hypothesis_id: 'H99',
        tool_plan_id: 'packer::diec',
        args_override: null,
      },
    })
    const r = validatePevOutput(out, makeCtx())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('illegal-tool-call')
  })

  test('tool_call against a falsified H', () => {
    const out = makeOutput({
      next_action: {
        kind: 'tool_call',
        hypothesis_id: 'H1',
        tool_plan_id: 'packer::diec',
        args_override: null,
      },
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'falsified', confidence: 0 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('illegal-tool-call')
  })

  test('tool_call against a mutated H', () => {
    const out = makeOutput({
      next_action: {
        kind: 'tool_call',
        hypothesis_id: 'H1',
        tool_plan_id: 'packer::diec',
        args_override: null,
      },
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'mutated', confidence: 0.4 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('illegal-tool-call')
  })
})

/* -------------------------------------------------------------------------- */
/* Edge cases                                                                 */
/* -------------------------------------------------------------------------- */

describe('validatePevOutput — edge cases', () => {
  test('non-tool_call next_action kinds skip plan lookup', () => {
    const ctx = makeCtx({
      // findToolPlan returns undefined for everything, but observe_only
      // shouldn't even invoke it.
      findToolPlan: () => undefined,
    })
    expect(validatePevOutput(makeOutput(), ctx).ok).toBe(true)
    expect(
      validatePevOutput(
        makeOutput({
          next_action: {
            kind: 'request_oracle',
            query: 'what is UPX 4.0',
            rationale: 'need oracle',
          },
        }),
        ctx,
      ).ok,
    ).toBe(true)
    expect(
      validatePevOutput(
        makeOutput({
          next_action: {
            kind: 'declare_done',
            rationale: 'no further work',
          },
        }),
        ctx,
      ).ok,
    ).toBe(true)
  })

  test('first error wins — identity-mismatch reported before round-mismatch', () => {
    const out = makeOutput({ agent_id: 'wrong', round: 99 })
    const r = validatePevOutput(out, makeCtx({ round: 0 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('identity-mismatch')
  })

  test('first error wins — round-mismatch reported before unknown-evidence', () => {
    const out = makeOutput({
      round: 99,
      observations: [
        { evidence_id: 'E99', verdict: 'confirms', confidence: 0.5 },
      ],
    })
    const r = validatePevOutput(out, makeCtx({ round: 0 }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('round-mismatch')
  })

  test('multiple ops in one array — first error returned, later ones ignored', () => {
    const out = makeOutput({
      hypothesis_updates: [
        {
          op: 'create',
          id: 'H1',
          kind: 'packer',
          text: 'duplicate creation',
          confidence: 0.5,
        },
        {
          op: 'create',
          id: 'H2',
          kind: 'compiler',
          text: 'this would have been valid',
          confidence: 0.5,
        },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [{ id: 'H1', status: 'open', confidence: 0.5 }],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.errorKind).toBe('id-collision')
  })

  test('promote and falsify on different ids, no contradiction', () => {
    const out = makeOutput({
      hypothesis_updates: [
        { op: 'promote', id: 'H1', rationale_short: 'promote H1' },
        { op: 'promote', id: 'H2', rationale_short: 'promote H2' },
      ],
    })
    const ctx = makeCtx({
      ledger: makeLedger({
        hypotheses: [
          { id: 'H1', status: 'open', confidence: 0.5 },
          { id: 'H2', status: 'open', confidence: 0.5 },
        ],
      }),
    })
    const r = validatePevOutput(out, ctx)
    expect(r.ok).toBe(true)
  })
})

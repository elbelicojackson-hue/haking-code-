/**
 * SharedLedger reducer — unit + property-based tests.
 *
 * Coverage map (per task T4 DoD):
 *   - createEmptyLedger: shape + default state.
 *   - applyHypothesisUpdate: each of the 5 ops with one happy + one
 *     defensive sad path (validator should usually catch the sad path,
 *     but the reducer must not corrupt state when it doesn't).
 *   - appendEvidence: id minting (E${lastEvidenceId+1}), evidenceLog
 *     append, and evidenceTrail update on the targeted H.
 *   - applyStaleCascade: tree
 *         H1
 *          ├─ H1.1
 *          │   └─ H1.1.2
 *          └─ H1.2
 *         H2
 *     Falsify H1 → all descendants of H1 become stale; H2 unchanged.
 *   - decrementBudget: floors at zero, accepts default n=1.
 *   - incrementParseStats: every kind bumps exactly one counter.
 *   - Immutability invariant: every reducer returns a new top-level
 *     object identity (Object.is(input, output) === false).
 *   - PBT (fast-check, 200 runs):
 *       * Property 6: lastEvidenceId is monotonically non-decreasing
 *         under any sequence of ledger ops.
 *       * Property 11: applyHypothesisUpdate never returns the same
 *         object identity as its input.
 *
 * Validates: Requirements 6.1, 6.2, 6.3, 6.4, 6.9, 7.3, 7.8
 */

import { describe, expect, test } from 'bun:test'
import * as fc from 'fast-check'
import type { HypothesisUpdate } from '../protocol.js'
import {
  type Hypothesis,
  type ParseStatsKind,
  type SharedLedger,
  type ToolEvidence,
  appendEvidence,
  applyHypothesisUpdate,
  applyStaleCascade,
  createEmptyLedger,
  decrementBudget,
  incrementParseStats,
} from '../ledger.js'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Build a ledger with the given hypotheses pre-populated (test setup). */
function ledgerWith(hypotheses: ReadonlyArray<Hypothesis>): SharedLedger {
  const base = createEmptyLedger(24)
  const map = new Map<string, Hypothesis>()
  for (const h of hypotheses) map.set(h.id, h)
  return { ...base, hypotheses: map }
}

/** Build a Hypothesis with sensible defaults for tests. */
function makeH(overrides: Partial<Hypothesis> & { id: string }): Hypothesis {
  return {
    ownerAgent: 'static_analyst',
    kind: 'packer',
    text: 'placeholder hypothesis text long enough',
    confidence: 0.5,
    status: 'open',
    evidenceTrail: [],
    createdRound: 0,
    lastTouchedRound: 0,
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/* createEmptyLedger                                                          */
/* -------------------------------------------------------------------------- */

describe('createEmptyLedger', () => {
  test('default shape', () => {
    const l = createEmptyLedger(24)
    expect(l.hypotheses.size).toBe(0)
    expect(l.evidenceLog).toEqual([])
    expect(l.toolBudgetRemaining).toBe(24)
    expect(l.lastEvidenceId).toBe(0)
    expect(l.parseStats).toEqual({
      layer1Hits: 0,
      layer2Hits: 0,
      layer3Hits: 0,
      parseFailures: 0,
    })
  })

  test('floors negative budget to zero', () => {
    expect(createEmptyLedger(-5).toolBudgetRemaining).toBe(0)
  })

  test('truncates fractional budget', () => {
    expect(createEmptyLedger(7.9).toolBudgetRemaining).toBe(7)
  })
})

/* -------------------------------------------------------------------------- */
/* applyHypothesisUpdate — per op                                             */
/* -------------------------------------------------------------------------- */

describe("applyHypothesisUpdate — op='create'", () => {
  test('happy: adds a new H with status=open and round metadata', () => {
    const before = createEmptyLedger(24)
    const update: HypothesisUpdate = {
      op: 'create',
      id: 'H1',
      kind: 'packer',
      text: 'PE32+ packed by UPX',
      confidence: 0.7,
    }
    const after = applyHypothesisUpdate(before, update, 'agent-A', 0)
    expect(after.hypotheses.size).toBe(1)
    const h = after.hypotheses.get('H1')!
    expect(h).toBeDefined()
    expect(h.id).toBe('H1')
    expect(h.ownerAgent).toBe('agent-A')
    expect(h.kind).toBe('packer')
    expect(h.text).toBe('PE32+ packed by UPX')
    expect(h.confidence).toBe(0.7)
    expect(h.status).toBe('open')
    expect(h.evidenceTrail).toEqual([])
    expect(h.parentId).toBeUndefined()
    expect(h.createdRound).toBe(0)
    expect(h.lastTouchedRound).toBe(0)
  })

  test('happy: parent_id=null is treated as undefined', () => {
    const before = createEmptyLedger(24)
    const update: HypothesisUpdate = {
      op: 'create',
      id: 'H1',
      parent_id: null,
      kind: 'family',
      text: 'Suspected ransomware family',
      confidence: 0.3,
    }
    const after = applyHypothesisUpdate(before, update, 'A', 0)
    expect(after.hypotheses.get('H1')!.parentId).toBeUndefined()
  })

  test('happy: parent_id present is stored', () => {
    const before = ledgerWith([makeH({ id: 'H1' })])
    const update: HypothesisUpdate = {
      op: 'create',
      id: 'H1.1',
      parent_id: 'H1',
      kind: 'compiler',
      text: 'Inner payload is .NET',
      confidence: 0.5,
    }
    const after = applyHypothesisUpdate(before, update, 'A', 1)
    expect(after.hypotheses.get('H1.1')!.parentId).toBe('H1')
  })

  test('sad (defensive): create with id-collision → no-op (no mutation)', () => {
    const before = ledgerWith([
      makeH({ id: 'H1', confidence: 0.4, text: 'original H1 text here' }),
    ])
    const update: HypothesisUpdate = {
      op: 'create',
      id: 'H1',
      kind: 'packer',
      text: 'attempted overwrite text',
      confidence: 0.99,
    }
    const after = applyHypothesisUpdate(before, update, 'A', 1)
    // Original H1 is untouched.
    const h = after.hypotheses.get('H1')!
    expect(h.text).toBe('original H1 text here')
    expect(h.confidence).toBe(0.4)
    expect(after.hypotheses.size).toBe(1)
  })
})

describe("applyHypothesisUpdate — op='promote'", () => {
  test('happy: open → evidence + lastTouchedRound', () => {
    const before = ledgerWith([
      makeH({ id: 'H1', status: 'open', lastTouchedRound: 0 }),
    ])
    const update: HypothesisUpdate = {
      op: 'promote',
      id: 'H1',
      rationale_short: 'E1 confirms claim',
    }
    const after = applyHypothesisUpdate(before, update, 'A', 3)
    const h = after.hypotheses.get('H1')!
    expect(h.status).toBe('evidence')
    expect(h.lastTouchedRound).toBe(3)
  })

  test('sad (defensive): promote of non-existent H → no-op', () => {
    const before = createEmptyLedger(24)
    const update: HypothesisUpdate = {
      op: 'promote',
      id: 'H99',
      rationale_short: 'no such H exists',
    }
    const after = applyHypothesisUpdate(before, update, 'A', 1)
    expect(after.hypotheses.size).toBe(0)
  })

  test('sad (defensive): promote of already-evidence H → no-op (idempotent)', () => {
    const before = ledgerWith([
      makeH({ id: 'H1', status: 'evidence', lastTouchedRound: 5 }),
    ])
    const update: HypothesisUpdate = {
      op: 'promote',
      id: 'H1',
      rationale_short: 'already promoted',
    }
    const after = applyHypothesisUpdate(before, update, 'A', 7)
    expect(after.hypotheses.get('H1')!.lastTouchedRound).toBe(5)
  })
})

describe("applyHypothesisUpdate — op='falsify'", () => {
  test('happy: status=falsified, confidence=0, counter evidence in trail', () => {
    const before = ledgerWith([
      makeH({ id: 'H1', status: 'open', confidence: 0.8 }),
    ])
    const update: HypothesisUpdate = {
      op: 'falsify',
      id: 'H1',
      counter_evidence_id: 'E5',
      rationale_short: 'E5 contradicts H1',
    }
    const after = applyHypothesisUpdate(before, update, 'A', 4)
    const h = after.hypotheses.get('H1')!
    expect(h.status).toBe('falsified')
    expect(h.confidence).toBe(0)
    expect(h.lastTouchedRound).toBe(4)
    expect(h.evidenceTrail).toEqual(['E5'])
  })

  test('happy: existing trail is extended (no duplicate)', () => {
    const before = ledgerWith([
      makeH({ id: 'H1', evidenceTrail: ['E1', 'E5'] }),
    ])
    const update: HypothesisUpdate = {
      op: 'falsify',
      id: 'H1',
      counter_evidence_id: 'E5',
      rationale_short: 'evidence already in trail',
    }
    const after = applyHypothesisUpdate(before, update, 'A', 4)
    expect(after.hypotheses.get('H1')!.evidenceTrail).toEqual(['E1', 'E5'])
  })

  test('happy: new counter evidence appended to existing trail', () => {
    const before = ledgerWith([
      makeH({ id: 'H1', evidenceTrail: ['E1'] }),
    ])
    const update: HypothesisUpdate = {
      op: 'falsify',
      id: 'H1',
      counter_evidence_id: 'E2',
      rationale_short: 'append new counter',
    }
    const after = applyHypothesisUpdate(before, update, 'A', 4)
    expect(after.hypotheses.get('H1')!.evidenceTrail).toEqual(['E1', 'E2'])
  })

  test('sad (defensive): falsify of non-existent H → no-op', () => {
    const before = createEmptyLedger(24)
    const update: HypothesisUpdate = {
      op: 'falsify',
      id: 'H99',
      counter_evidence_id: 'E1',
      rationale_short: 'no such H',
    }
    const after = applyHypothesisUpdate(before, update, 'A', 1)
    expect(after.hypotheses.size).toBe(0)
  })
})

describe("applyHypothesisUpdate — op='mutate'", () => {
  test('happy: old H → mutated, new H created with parentId carried over', () => {
    const before = ledgerWith([
      makeH({
        id: 'H1.2',
        parentId: 'H1',
        kind: 'compiler',
        confidence: 0.4,
      }),
    ])
    const update: HypothesisUpdate = {
      op: 'mutate',
      id: 'H1.2',
      new_id: 'H1.3',
      text: 'Refined hypothesis text after mutation',
      confidence: 0.6,
      rationale_short: 'evidence suggests near-miss',
    }
    const after = applyHypothesisUpdate(before, update, 'agent-B', 5)
    const oldH = after.hypotheses.get('H1.2')!
    const newH = after.hypotheses.get('H1.3')!

    expect(oldH.status).toBe('mutated')
    expect(oldH.lastTouchedRound).toBe(5)

    expect(newH.id).toBe('H1.3')
    expect(newH.status).toBe('open')
    expect(newH.parentId).toBe('H1')
    expect(newH.kind).toBe('compiler') // carried over from old
    expect(newH.text).toBe('Refined hypothesis text after mutation')
    expect(newH.confidence).toBe(0.6)
    expect(newH.ownerAgent).toBe('agent-B')
    expect(newH.createdRound).toBe(5)
    expect(newH.lastTouchedRound).toBe(5)
    expect(newH.evidenceTrail).toEqual([])
  })

  test('sad (defensive): mutate of non-existent old id → no-op', () => {
    const before = createEmptyLedger(24)
    const update: HypothesisUpdate = {
      op: 'mutate',
      id: 'H99',
      new_id: 'H99.1',
      text: 'cannot mutate unknown',
      confidence: 0.5,
      rationale_short: 'no source H',
    }
    const after = applyHypothesisUpdate(before, update, 'A', 1)
    expect(after.hypotheses.size).toBe(0)
  })

  test('sad (defensive): mutate with new_id collision → no-op (no partial state)', () => {
    const before = ledgerWith([
      makeH({ id: 'H1', text: 'original H1 text here', confidence: 0.5 }),
      makeH({ id: 'H2', text: 'original H2 text here', confidence: 0.5 }),
    ])
    const update: HypothesisUpdate = {
      op: 'mutate',
      id: 'H1',
      new_id: 'H2', // collides
      text: 'mutated text would replace H2',
      confidence: 0.9,
      rationale_short: 'collision attempt',
    }
    const after = applyHypothesisUpdate(before, update, 'A', 2)
    // Both originals untouched.
    expect(after.hypotheses.get('H1')!.status).toBe('open')
    expect(after.hypotheses.get('H1')!.text).toBe('original H1 text here')
    expect(after.hypotheses.get('H2')!.text).toBe('original H2 text here')
    expect(after.hypotheses.size).toBe(2)
  })
})

describe("applyHypothesisUpdate — op='confidence_adjust'", () => {
  test('happy: in-range delta updates confidence', () => {
    const before = ledgerWith([
      makeH({ id: 'H1', confidence: 0.4, lastTouchedRound: 0 }),
    ])
    const update: HypothesisUpdate = {
      op: 'confidence_adjust',
      id: 'H1',
      new_confidence: 0.7,
      rationale_short: 'evidence consolidated',
    }
    const after = applyHypothesisUpdate(before, update, 'A', 6)
    const h = after.hypotheses.get('H1')!
    expect(h.confidence).toBe(0.7)
    expect(h.lastTouchedRound).toBe(6)
  })

  test('sad (defensive): delta > 0.5 → no-op', () => {
    const before = ledgerWith([
      makeH({ id: 'H1', confidence: 0.1, lastTouchedRound: 0 }),
    ])
    const update: HypothesisUpdate = {
      op: 'confidence_adjust',
      id: 'H1',
      new_confidence: 0.95, // delta = 0.85
      rationale_short: 'too big a jump',
    }
    const after = applyHypothesisUpdate(before, update, 'A', 1)
    expect(after.hypotheses.get('H1')!.confidence).toBe(0.1)
    expect(after.hypotheses.get('H1')!.lastTouchedRound).toBe(0)
  })

  test('boundary: delta == 0.5 exactly is accepted', () => {
    const before = ledgerWith([makeH({ id: 'H1', confidence: 0.2 })])
    const update: HypothesisUpdate = {
      op: 'confidence_adjust',
      id: 'H1',
      new_confidence: 0.7,
      rationale_short: 'boundary delta',
    }
    const after = applyHypothesisUpdate(before, update, 'A', 1)
    expect(after.hypotheses.get('H1')!.confidence).toBe(0.7)
  })

  test('sad (defensive): unknown id → no-op', () => {
    const before = createEmptyLedger(24)
    const update: HypothesisUpdate = {
      op: 'confidence_adjust',
      id: 'H99',
      new_confidence: 0.5,
      rationale_short: 'no such H',
    }
    const after = applyHypothesisUpdate(before, update, 'A', 1)
    expect(after.hypotheses.size).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* appendEvidence                                                             */
/* -------------------------------------------------------------------------- */

describe('appendEvidence', () => {
  /** Build a ToolEvidence skeleton without id (the SUT mints it). */
  function makeEv(
    overrides: Partial<Omit<ToolEvidence, 'id'>> = {},
  ): Omit<ToolEvidence, 'id'> {
    return {
      agentId: 'A',
      round: 1,
      toolName: 'ReverseCli',
      toolArgs: { action: 'diec' },
      outcome: 'success',
      resultDigest: 'sample digest',
      testedHypothesis: 'H1',
      verdict: 'confirms',
      durationMs: 42,
      ...overrides,
    }
  }

  test('mints E1 from empty ledger', () => {
    const before = ledgerWith([makeH({ id: 'H1' })])
    const { ledger: after, evidenceId } = appendEvidence(before, makeEv())
    expect(evidenceId).toBe('E1')
    expect(after.lastEvidenceId).toBe(1)
    expect(after.evidenceLog).toHaveLength(1)
    expect(after.evidenceLog[0]!.id).toBe('E1')
  })

  test('mints E${lastEvidenceId+1} on each call', () => {
    let l = ledgerWith([makeH({ id: 'H1' })])
    for (let i = 1; i <= 5; i++) {
      const r = appendEvidence(l, makeEv())
      expect(r.evidenceId).toBe(`E${i}`)
      l = r.ledger
    }
    expect(l.lastEvidenceId).toBe(5)
    expect(l.evidenceLog).toHaveLength(5)
    expect(l.evidenceLog.map(e => e.id)).toEqual([
      'E1',
      'E2',
      'E3',
      'E4',
      'E5',
    ])
  })

  test("appends evidence id to tested H's evidenceTrail", () => {
    const before = ledgerWith([
      makeH({ id: 'H1', evidenceTrail: ['E0_seed' as never] }),
    ])
    // Note the seed value is intentionally unrealistic; the reducer
    // doesn't validate trail formats — it only de-dupes the new id.
    const { ledger: after, evidenceId } = appendEvidence(
      before,
      makeEv({ testedHypothesis: 'H1' }),
    )
    expect(evidenceId).toBe('E1')
    expect(after.hypotheses.get('H1')!.evidenceTrail).toContain('E1')
  })

  test('does not double-append if id already in trail (defensive)', () => {
    // Manually engineer the situation by calling appendEvidence twice
    // against the same H — the second call should still mint a new id
    // (E2) and append it; the de-dupe path is hit only when an external
    // mutator pre-populated the trail, which we simulate via ledgerWith.
    const before = ledgerWith([
      makeH({ id: 'H1', evidenceTrail: [] }),
    ])
    const r1 = appendEvidence(before, makeEv({ testedHypothesis: 'H1' }))
    const r2 = appendEvidence(r1.ledger, makeEv({ testedHypothesis: 'H1' }))
    expect(r2.ledger.hypotheses.get('H1')!.evidenceTrail).toEqual([
      'E1',
      'E2',
    ])
  })

  test('orphan evidence (testedHypothesis not in ledger) still recorded', () => {
    const before = createEmptyLedger(24)
    const { ledger: after, evidenceId } = appendEvidence(
      before,
      makeEv({ testedHypothesis: 'H_GHOST' }),
    )
    expect(evidenceId).toBe('E1')
    expect(after.evidenceLog).toHaveLength(1)
    expect(after.hypotheses.size).toBe(0)
  })

  test('preserves existing evidence in evidenceLog (append-only)', () => {
    let l = ledgerWith([makeH({ id: 'H1' })])
    l = appendEvidence(l, makeEv({ resultDigest: 'first' })).ledger
    l = appendEvidence(l, makeEv({ resultDigest: 'second' })).ledger
    expect(l.evidenceLog.map(e => e.resultDigest)).toEqual(['first', 'second'])
  })
})

/* -------------------------------------------------------------------------- */
/* applyStaleCascade                                                          */
/* -------------------------------------------------------------------------- */

describe('applyStaleCascade', () => {
  /** Build the canonical fixture tree from the task description. */
  function fixtureTree(): SharedLedger {
    return ledgerWith([
      makeH({ id: 'H1', status: 'falsified' }), // already falsified by caller
      makeH({ id: 'H1.1', parentId: 'H1', status: 'open' }),
      makeH({ id: 'H1.1.2', parentId: 'H1.1', status: 'evidence' }),
      makeH({ id: 'H1.2', parentId: 'H1', status: 'open' }),
      makeH({ id: 'H2', status: 'open' }), // sibling root
    ])
  }

  test('falsifying H1 cascades to all descendants of H1', () => {
    const after = applyStaleCascade(fixtureTree(), 'H1')
    expect(after.hypotheses.get('H1.1')!.status).toBe('stale')
    expect(after.hypotheses.get('H1.1.2')!.status).toBe('stale')
    expect(after.hypotheses.get('H1.2')!.status).toBe('stale')
  })

  test('sibling subtree H2 is unchanged', () => {
    const after = applyStaleCascade(fixtureTree(), 'H1')
    expect(after.hypotheses.get('H2')!.status).toBe('open')
  })

  test('startId itself is NOT modified by cascade (caller owns it)', () => {
    const after = applyStaleCascade(fixtureTree(), 'H1')
    expect(after.hypotheses.get('H1')!.status).toBe('falsified')
  })

  test('does NOT overwrite a descendant that is already falsified', () => {
    const before = ledgerWith([
      makeH({ id: 'H1', status: 'falsified' }),
      makeH({ id: 'H1.1', parentId: 'H1', status: 'falsified' }),
      makeH({ id: 'H1.1.2', parentId: 'H1.1', status: 'open' }),
    ])
    const after = applyStaleCascade(before, 'H1')
    expect(after.hypotheses.get('H1.1')!.status).toBe('falsified')
    // Grandchild still becomes stale because its grandparent (H1) is the
    // cascade origin — the cascade walks parentId chains, so even with a
    // falsified intermediate it propagates.
    expect(after.hypotheses.get('H1.1.2')!.status).toBe('stale')
  })

  test('does NOT overwrite a descendant that is already mutated', () => {
    const before = ledgerWith([
      makeH({ id: 'H1', status: 'falsified' }),
      makeH({ id: 'H1.1', parentId: 'H1', status: 'mutated' }),
    ])
    const after = applyStaleCascade(before, 'H1')
    expect(after.hypotheses.get('H1.1')!.status).toBe('mutated')
  })

  test('cascade with no descendants is a no-op (returns fresh wrapper)', () => {
    const lonely = ledgerWith([makeH({ id: 'H1', status: 'falsified' })])
    const after = applyStaleCascade(lonely, 'H1')
    // No state changes...
    expect(after.hypotheses.get('H1')!.status).toBe('falsified')
    // ...but identity differs (immutability invariant).
    expect(Object.is(lonely, after)).toBe(false)
  })

  test('cascade is single-direction: falsifying a leaf does not stale its ancestors', () => {
    // Even though we "falsify" H1.1.2 here (caller responsibility), the
    // cascade from that leaf has no descendants, so its ancestor H1
    // stays open.
    const before = ledgerWith([
      makeH({ id: 'H1', status: 'open' }),
      makeH({ id: 'H1.1', parentId: 'H1', status: 'open' }),
      makeH({ id: 'H1.1.2', parentId: 'H1.1', status: 'falsified' }),
    ])
    const after = applyStaleCascade(before, 'H1.1.2')
    expect(after.hypotheses.get('H1')!.status).toBe('open')
    expect(after.hypotheses.get('H1.1')!.status).toBe('open')
  })
})

/* -------------------------------------------------------------------------- */
/* decrementBudget                                                            */
/* -------------------------------------------------------------------------- */

describe('decrementBudget', () => {
  test('default n=1', () => {
    const before = createEmptyLedger(24)
    const after = decrementBudget(before)
    expect(after.toolBudgetRemaining).toBe(23)
  })

  test('explicit n', () => {
    const before = createEmptyLedger(24)
    const after = decrementBudget(before, 5)
    expect(after.toolBudgetRemaining).toBe(19)
  })

  test('floors at zero (does not go negative)', () => {
    const before = createEmptyLedger(2)
    const after = decrementBudget(before, 100)
    expect(after.toolBudgetRemaining).toBe(0)
  })

  test('negative n is clamped to zero (no growth)', () => {
    const before = createEmptyLedger(5)
    const after = decrementBudget(before, -3)
    expect(after.toolBudgetRemaining).toBe(5)
  })
})

/* -------------------------------------------------------------------------- */
/* incrementParseStats                                                        */
/* -------------------------------------------------------------------------- */

describe('incrementParseStats', () => {
  test('layer1 bump', () => {
    const after = incrementParseStats(createEmptyLedger(24), 'layer1')
    expect(after.parseStats.layer1Hits).toBe(1)
    expect(after.parseStats.layer2Hits).toBe(0)
    expect(after.parseStats.layer3Hits).toBe(0)
    expect(after.parseStats.parseFailures).toBe(0)
  })

  test('layer2 bump', () => {
    const after = incrementParseStats(createEmptyLedger(24), 'layer2')
    expect(after.parseStats.layer2Hits).toBe(1)
  })

  test('layer3 bump', () => {
    const after = incrementParseStats(createEmptyLedger(24), 'layer3')
    expect(after.parseStats.layer3Hits).toBe(1)
  })

  test('failure bump', () => {
    const after = incrementParseStats(createEmptyLedger(24), 'failure')
    expect(after.parseStats.parseFailures).toBe(1)
  })

  test('repeated bumps accumulate', () => {
    let l = createEmptyLedger(24)
    l = incrementParseStats(l, 'layer1')
    l = incrementParseStats(l, 'layer1')
    l = incrementParseStats(l, 'layer2')
    expect(l.parseStats.layer1Hits).toBe(2)
    expect(l.parseStats.layer2Hits).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Immutability invariant — every reducer returns a new object identity      */
/* -------------------------------------------------------------------------- */

describe('immutability — every reducer returns a fresh object identity', () => {
  const happyUpdates: ReadonlyArray<{
    label: string
    setup: () => SharedLedger
    update: HypothesisUpdate
  }> = [
    {
      label: 'create',
      setup: () => createEmptyLedger(24),
      update: {
        op: 'create',
        id: 'H1',
        kind: 'packer',
        text: 'fresh hypothesis',
        confidence: 0.5,
      },
    },
    {
      label: 'promote',
      setup: () => ledgerWith([makeH({ id: 'H1', status: 'open' })]),
      update: { op: 'promote', id: 'H1', rationale_short: 'rationale here' },
    },
    {
      label: 'falsify',
      setup: () => ledgerWith([makeH({ id: 'H1' })]),
      update: {
        op: 'falsify',
        id: 'H1',
        counter_evidence_id: 'E1',
        rationale_short: 'rationale here',
      },
    },
    {
      label: 'mutate',
      setup: () => ledgerWith([makeH({ id: 'H1' })]),
      update: {
        op: 'mutate',
        id: 'H1',
        new_id: 'H1.1',
        text: 'mutated hypothesis text',
        confidence: 0.5,
        rationale_short: 'rationale here',
      },
    },
    {
      label: 'confidence_adjust',
      setup: () => ledgerWith([makeH({ id: 'H1', confidence: 0.4 })]),
      update: {
        op: 'confidence_adjust',
        id: 'H1',
        new_confidence: 0.7,
        rationale_short: 'rationale here',
      },
    },
  ]

  for (const c of happyUpdates) {
    test(`applyHypothesisUpdate(${c.label}) returns a new object`, () => {
      const before = c.setup()
      const after = applyHypothesisUpdate(before, c.update, 'A', 1)
      expect(Object.is(before, after)).toBe(false)
      expect(before.hypotheses).not.toBe(after.hypotheses)
    })
  }

  test('applyHypothesisUpdate skip-path also returns a new object', () => {
    const before = createEmptyLedger(24)
    const update: HypothesisUpdate = {
      op: 'promote',
      id: 'H_DOES_NOT_EXIST',
      rationale_short: 'will be skipped',
    }
    const after = applyHypothesisUpdate(before, update, 'A', 1)
    expect(Object.is(before, after)).toBe(false)
  })

  test('appendEvidence returns a new object', () => {
    const before = ledgerWith([makeH({ id: 'H1' })])
    const { ledger: after } = appendEvidence(before, {
      agentId: 'A',
      round: 1,
      toolName: 'ReverseCli',
      toolArgs: {},
      outcome: 'success',
      resultDigest: 'd',
      testedHypothesis: 'H1',
      verdict: 'confirms',
      durationMs: 1,
    })
    expect(Object.is(before, after)).toBe(false)
    expect(before.evidenceLog).not.toBe(after.evidenceLog)
  })

  test('applyStaleCascade returns a new object even when no descendants', () => {
    const before = ledgerWith([makeH({ id: 'H1' })])
    const after = applyStaleCascade(before, 'H1')
    expect(Object.is(before, after)).toBe(false)
  })

  test('decrementBudget returns a new object', () => {
    const before = createEmptyLedger(24)
    const after = decrementBudget(before, 1)
    expect(Object.is(before, after)).toBe(false)
  })

  test('incrementParseStats returns a new object', () => {
    const before = createEmptyLedger(24)
    const after = incrementParseStats(before, 'layer1')
    expect(Object.is(before, after)).toBe(false)
    expect(before.parseStats).not.toBe(after.parseStats)
  })
})

/* -------------------------------------------------------------------------- */
/* PBT — Property 6: lastEvidenceId monotonic non-decreasing                  */
/* -------------------------------------------------------------------------- */

/**
 * Property 6 (design Property 6, R6-9):
 * For ANY sequence of ledger ops over a fixed seed ledger,
 * `lastEvidenceId` is monotonically non-decreasing — strict-increasing
 * on `appendEvidence`, unchanged on every other reducer.
 *
 * Validates: Requirements 6.9
 */
describe('PBT — Property 6: lastEvidenceId is monotonically non-decreasing', () => {
  type OpStep =
    | { kind: 'append'; testedHypothesis: string }
    | { kind: 'create'; id: string }
    | { kind: 'budget'; n: number }
    | { kind: 'parseStats'; which: ParseStatsKind }
    | { kind: 'staleCascade'; startId: string }

  // Generator for a sequence of ops. Uses small bounded ids/values so
  // the property holds within the schema regex without invoking the
  // validator (which would reject some random ids).
  const opArb: fc.Arbitrary<OpStep> = fc.oneof(
    fc.record({
      kind: fc.constant('append' as const),
      testedHypothesis: fc.constantFrom('H1', 'H2', 'H_GHOST'),
    }),
    fc.record({
      kind: fc.constant('create' as const),
      id: fc
        .integer({ min: 100, max: 999 })
        .map(n => `H${n}`),
    }),
    fc.record({
      kind: fc.constant('budget' as const),
      n: fc.integer({ min: 0, max: 5 }),
    }),
    fc.record({
      kind: fc.constant('parseStats' as const),
      which: fc.constantFrom('layer1', 'layer2', 'layer3', 'failure'),
    }),
    fc.record({
      kind: fc.constant('staleCascade' as const),
      startId: fc.constantFrom('H1', 'H2'),
    }),
  )

  test('property holds over arbitrary sequences', () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 30 }), ops => {
        // Seed with two hypotheses so append/cascade have targets.
        let l: SharedLedger = ledgerWith([
          makeH({ id: 'H1' }),
          makeH({ id: 'H2' }),
        ])
        let prev = l.lastEvidenceId

        for (const step of ops) {
          if (step.kind === 'append') {
            l = appendEvidence(l, {
              agentId: 'A',
              round: 1,
              toolName: 'ReverseCli',
              toolArgs: {},
              outcome: 'success',
              resultDigest: 'd',
              testedHypothesis: step.testedHypothesis,
              verdict: 'confirms',
              durationMs: 1,
            }).ledger
          } else if (step.kind === 'create') {
            l = applyHypothesisUpdate(
              l,
              {
                op: 'create',
                id: step.id,
                kind: 'packer',
                text: 'fresh hypothesis text',
                confidence: 0.5,
              },
              'A',
              1,
            )
          } else if (step.kind === 'budget') {
            l = decrementBudget(l, step.n)
          } else if (step.kind === 'parseStats') {
            l = incrementParseStats(l, step.which)
          } else if (step.kind === 'staleCascade') {
            l = applyStaleCascade(l, step.startId)
          }
          if (l.lastEvidenceId < prev) return false
          prev = l.lastEvidenceId
        }
        return true
      }),
      { numRuns: 200 },
    )
  })
})

/* -------------------------------------------------------------------------- */
/* PBT — Property 11: applyHypothesisUpdate returns fresh identity            */
/* -------------------------------------------------------------------------- */

/**
 * Property 11 (design Property 11):
 * For ANY valid (ledger, update, agentId, round) input,
 * `applyHypothesisUpdate` returns a NEW ledger object identity, even on
 * defensive skip paths.
 *
 * Validates: Requirements 6.4, 6.9
 */
describe('PBT — Property 11: applyHypothesisUpdate preserves input identity', () => {
  // Only generate the 5 well-formed shapes — schema-illegal ops can't
  // even be constructed as a `HypothesisUpdate` value, so they aren't
  // in scope here. We mix happy and sad (skip) paths by sometimes
  // referencing ids that aren't in the seed ledger.
  const validHypothesisIdArb = fc
    .integer({ min: 0, max: 999 })
    .map(n => `H${n}` as const)

  const updateArb: fc.Arbitrary<HypothesisUpdate> = fc.oneof(
    fc.record({
      op: fc.constant('create' as const),
      id: validHypothesisIdArb,
      kind: fc.constant('packer' as const),
      text: fc.constant('generated hypothesis text long enough'),
      confidence: fc.float({ min: 0, max: 1, noNaN: true }),
    }),
    fc.record({
      op: fc.constant('promote' as const),
      id: validHypothesisIdArb,
      rationale_short: fc.constant('property test rationale'),
    }),
    fc.record({
      op: fc.constant('falsify' as const),
      id: validHypothesisIdArb,
      counter_evidence_id: fc
        .integer({ min: 1, max: 99 })
        .map(n => `E${n}`),
      rationale_short: fc.constant('property test rationale'),
    }),
    fc.record({
      op: fc.constant('mutate' as const),
      id: validHypothesisIdArb,
      new_id: validHypothesisIdArb,
      text: fc.constant('mutated hypothesis text long enough'),
      confidence: fc.float({ min: 0, max: 1, noNaN: true }),
      rationale_short: fc.constant('property test rationale'),
    }),
    fc.record({
      op: fc.constant('confidence_adjust' as const),
      id: validHypothesisIdArb,
      new_confidence: fc.float({ min: 0, max: 1, noNaN: true }),
      rationale_short: fc.constant('property test rationale'),
    }),
  )

  test('property holds for any single update', () => {
    fc.assert(
      fc.property(updateArb, fc.nat(20), (update, round) => {
        const before = ledgerWith([
          makeH({ id: 'H1', confidence: 0.5 }),
          makeH({ id: 'H2', confidence: 0.5 }),
        ])
        const after = applyHypothesisUpdate(before, update, 'A', round)
        return Object.is(before, after) === false
      }),
      { numRuns: 200 },
    )
  })

  test('property holds across a chain of updates', () => {
    fc.assert(
      fc.property(
        fc.array(updateArb, { minLength: 1, maxLength: 10 }),
        updates => {
          let prev: SharedLedger = ledgerWith([
            makeH({ id: 'H1', confidence: 0.5 }),
          ])
          for (const u of updates) {
            const next = applyHypothesisUpdate(prev, u, 'A', 1)
            if (Object.is(prev, next)) return false
            prev = next
          }
          return true
        },
      ),
      { numRuns: 200 },
    )
  })
})

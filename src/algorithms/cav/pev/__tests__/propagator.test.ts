/**
 * Cross-agent Propagator — unit + property-based tests.
 *
 * Coverage map (per task T8 DoD):
 *   - Property 10 (self-reflexive invariance): an agent never receives
 *     its own evidence in `newEvidenceForMe` (R9-8).
 *   - Cross-kind push: a confirmed packer evidence is propagated to a
 *     peer compiler-agent (DERIVE_RULES['packer'] = ['compiler', ...]).
 *   - Same-kind push: a peer agent owning an H of identical kind also
 *     receives the evidence.
 *   - Inbox cap = 5 (R9-6): ≥ 6 relevant evidences ⇒ at most 5 land in
 *     `newEvidenceForMe`, with confirms surfacing first.
 *   - Verdict ordering (R9-7): confirms before falsifies before mutates
 *     before inconclusive.
 *   - Stale notice: H1 with status='stale' ⇒ owner receives `['H1']`.
 *   - DERIVE_RULES expansion: a packer H promoted last round ⇒ owner's
 *     `newHypothesisFromPeer` carries kind=compiler + kind=capability
 *     children, parentId=promotedH.id, status='open', confidence ≈ 0.3.
 *   - Empty round (currentRound=0) and empty agent list edge cases.
 *   - Old-round evidence (round ≠ currentRound-1) is NOT propagated.
 *   - Synthetic child id minting respects depth cap (`H1.2.3.4` has no
 *     synthetic descendants).
 *   - Pure function: input ledger is not mutated; identical inputs
 *     produce structurally identical outputs.
 *   - PBT Property 10: random sequences of mixed-kind evidence never
 *     leak self-evidence into the producer's inbox.
 *
 * Validates: Requirements 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8
 */

import { describe, expect, test } from 'bun:test'
import * as fc from 'fast-check'
import {
  type Hypothesis,
  type SharedLedger,
  type ToolEvidence,
  createEmptyLedger,
} from '../ledger.js'
import type {
  EvidenceId,
  HypothesisKind,
  Verdict,
} from '../protocol.js'
import {
  DERIVE_RULES,
  type AgentInbox,
  propagate,
} from '../propagator.js'
import type { AgentDescriptor } from '../scheduler.js'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function makeH(overrides: Partial<Hypothesis> & { id: string }): Hypothesis {
  return {
    ownerAgent: 'agent-A',
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

function makeEv(overrides: Partial<ToolEvidence> & { id: EvidenceId }): ToolEvidence {
  return {
    agentId: 'agent-A',
    round: 0,
    toolName: 'ReverseCli',
    toolArgs: {},
    outcome: 'success',
    resultDigest: '...',
    testedHypothesis: 'H1',
    verdict: 'confirms',
    durationMs: 10,
    ...overrides,
  }
}

/** Build a ledger with the given hypotheses + evidence pre-populated. */
function ledgerWith(
  hypotheses: ReadonlyArray<Hypothesis>,
  evidence: ReadonlyArray<ToolEvidence> = [],
): SharedLedger {
  const base = createEmptyLedger(24)
  const map = new Map<string, Hypothesis>()
  for (const h of hypotheses) map.set(h.id, h)
  return {
    ...base,
    hypotheses: map,
    evidenceLog: [...evidence],
    lastEvidenceId: evidence.length,
  }
}

const A: AgentDescriptor = { id: 'agent-A' }
const B: AgentDescriptor = { id: 'agent-B' }
const C: AgentDescriptor = { id: 'agent-C' }

/* -------------------------------------------------------------------------- */
/* Empty inputs                                                               */
/* -------------------------------------------------------------------------- */

describe('propagate — empty inputs', () => {
  test('empty agent list ⇒ empty result', () => {
    const ledger = ledgerWith([])
    const { perAgentInbox } = propagate(ledger, [], 1)
    expect(perAgentInbox.size).toBe(0)
  })

  test('round 0 ⇒ no evidence pushed (no previous round)', () => {
    const ledger = ledgerWith(
      [makeH({ id: 'H1', kind: 'packer', ownerAgent: 'agent-B' })],
      [
        makeEv({
          id: 'E1',
          round: -1, // theoretical "before round 0"
          agentId: 'agent-A',
          testedHypothesis: 'H1',
        }),
      ],
    )
    const { perAgentInbox } = propagate(ledger, [A, B], 0)
    expect(perAgentInbox.get('agent-A')!.newEvidenceForMe).toHaveLength(0)
    expect(perAgentInbox.get('agent-B')!.newEvidenceForMe).toHaveLength(0)
  })

  test('every agent gets an inbox entry, even when nothing applies', () => {
    const ledger = ledgerWith([])
    const { perAgentInbox } = propagate(ledger, [A, B, C], 1)
    expect(perAgentInbox.size).toBe(3)
    for (const id of ['agent-A', 'agent-B', 'agent-C']) {
      const inbox = perAgentInbox.get(id)!
      expect(inbox).toBeDefined()
      expect(inbox.newEvidenceForMe).toEqual([])
      expect(inbox.newHypothesisFromPeer).toEqual([])
      expect(inbox.staleNotice).toEqual([])
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Property 10 — no self-feedback                                             */
/* -------------------------------------------------------------------------- */

describe('propagate — Property 10: self-reflexive invariance (R9-8)', () => {
  test("an agent never sees their own evidence in newEvidenceForMe", () => {
    // Agent A produces an evidence; agent B owns a packer H so the
    // evidence is relevant. A also owns a packer H — it should still NOT
    // get the evidence routed back.
    const ledger = ledgerWith(
      [
        makeH({ id: 'H1', ownerAgent: 'agent-A', kind: 'packer' }),
        makeH({ id: 'H2', ownerAgent: 'agent-B', kind: 'packer' }),
      ],
      [
        makeEv({
          id: 'E1',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
          verdict: 'confirms',
        }),
      ],
    )
    const { perAgentInbox } = propagate(ledger, [A, B], 1)
    expect(perAgentInbox.get('agent-A')!.newEvidenceForMe).toHaveLength(0)
    expect(perAgentInbox.get('agent-B')!.newEvidenceForMe).toHaveLength(1)
    expect(perAgentInbox.get('agent-B')!.newEvidenceForMe[0]!.id).toBe('E1')
  })

  test('multiple producers — each excluded only from their own inbox', () => {
    const ledger = ledgerWith(
      [
        makeH({ id: 'H1', ownerAgent: 'agent-A', kind: 'packer' }),
        makeH({ id: 'H2', ownerAgent: 'agent-B', kind: 'packer' }),
        makeH({ id: 'H3', ownerAgent: 'agent-C', kind: 'packer' }),
      ],
      [
        makeEv({
          id: 'E1',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
        }),
        makeEv({
          id: 'E2',
          round: 0,
          agentId: 'agent-B',
          testedHypothesis: 'H2',
        }),
      ],
    )
    const { perAgentInbox } = propagate(ledger, [A, B, C], 1)

    // A owns its own E1; should only see E2.
    const aIds = perAgentInbox.get('agent-A')!.newEvidenceForMe.map(e => e.id)
    expect(aIds).toEqual(['E2'])

    // B owns its own E2; should only see E1.
    const bIds = perAgentInbox.get('agent-B')!.newEvidenceForMe.map(e => e.id)
    expect(bIds).toEqual(['E1'])

    // C owns nothing produced; should see both.
    const cIds = perAgentInbox.get('agent-C')!.newEvidenceForMe.map(e => e.id)
    expect(cIds.sort()).toEqual(['E1', 'E2'])
  })
})

/* -------------------------------------------------------------------------- */
/* Cross-kind / same-kind push                                                */
/* -------------------------------------------------------------------------- */

describe('propagate — kind-based routing (R9-3)', () => {
  test('same-kind push: packer evidence ⇒ packer-agent inbox', () => {
    const ledger = ledgerWith(
      [
        makeH({ id: 'H1', ownerAgent: 'agent-A', kind: 'packer' }),
        makeH({ id: 'H2', ownerAgent: 'agent-B', kind: 'packer' }),
      ],
      [
        makeEv({
          id: 'E1',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
        }),
      ],
    )
    const { perAgentInbox } = propagate(ledger, [A, B], 1)
    expect(perAgentInbox.get('agent-B')!.newEvidenceForMe.map(e => e.id)).toEqual([
      'E1',
    ])
  })

  test('cross-kind push via DERIVE_RULES: packer ⇒ compiler-agent', () => {
    // DERIVE_RULES['packer'] = ['compiler', 'capability']
    const ledger = ledgerWith(
      [
        makeH({ id: 'H1', ownerAgent: 'agent-A', kind: 'packer' }),
        makeH({ id: 'H2', ownerAgent: 'agent-B', kind: 'compiler' }),
      ],
      [
        makeEv({
          id: 'E1',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
          verdict: 'confirms',
        }),
      ],
    )
    const { perAgentInbox } = propagate(ledger, [A, B], 1)
    expect(perAgentInbox.get('agent-B')!.newEvidenceForMe.map(e => e.id)).toEqual([
      'E1',
    ])
  })

  test('cross-kind push: packer ⇒ capability-agent', () => {
    const ledger = ledgerWith(
      [
        makeH({ id: 'H1', ownerAgent: 'agent-A', kind: 'packer' }),
        makeH({ id: 'H2', ownerAgent: 'agent-B', kind: 'capability' }),
      ],
      [
        makeEv({
          id: 'E1',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
        }),
      ],
    )
    const { perAgentInbox } = propagate(ledger, [A, B], 1)
    expect(perAgentInbox.get('agent-B')!.newEvidenceForMe).toHaveLength(1)
  })

  test('unrelated kind ⇒ no push', () => {
    // DERIVE_RULES['packer'] does NOT include 'protocol'.
    const ledger = ledgerWith(
      [
        makeH({ id: 'H1', ownerAgent: 'agent-A', kind: 'packer' }),
        makeH({ id: 'H2', ownerAgent: 'agent-B', kind: 'protocol' }),
      ],
      [
        makeEv({
          id: 'E1',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
        }),
      ],
    )
    const { perAgentInbox } = propagate(ledger, [A, B], 1)
    expect(perAgentInbox.get('agent-B')!.newEvidenceForMe).toHaveLength(0)
  })

  test('inactive (stale/falsified/mutated) own H does NOT count for routing', () => {
    const ledger = ledgerWith(
      [
        makeH({ id: 'H1', ownerAgent: 'agent-A', kind: 'packer' }),
        makeH({
          id: 'H2',
          ownerAgent: 'agent-B',
          kind: 'packer',
          status: 'stale',
        }),
      ],
      [
        makeEv({
          id: 'E1',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
        }),
      ],
    )
    const { perAgentInbox } = propagate(ledger, [A, B], 1)
    // B's only packer H is stale, so the packer evidence is not relevant.
    expect(perAgentInbox.get('agent-B')!.newEvidenceForMe).toHaveLength(0)
  })

  test('cross-agent push reaches at least one peer (R9-3)', () => {
    // R9-3 specifies "至少一个其他 agent" — verify by counting recipients.
    const ledger = ledgerWith(
      [
        makeH({ id: 'H1', ownerAgent: 'agent-A', kind: 'packer' }),
        makeH({ id: 'H2', ownerAgent: 'agent-B', kind: 'compiler' }),
        makeH({ id: 'H3', ownerAgent: 'agent-C', kind: 'capability' }),
      ],
      [
        makeEv({
          id: 'E1',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
          verdict: 'confirms',
        }),
      ],
    )
    const { perAgentInbox } = propagate(ledger, [A, B, C], 1)
    let recipients = 0
    for (const [aid, inbox] of perAgentInbox) {
      if (aid === 'agent-A') continue
      if (inbox.newEvidenceForMe.length > 0) recipients += 1
    }
    expect(recipients).toBeGreaterThanOrEqual(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Round filtering                                                            */
/* -------------------------------------------------------------------------- */

describe('propagate — round filtering', () => {
  test('only currentRound-1 evidence is propagated; older rounds ignored', () => {
    const ledger = ledgerWith(
      [
        makeH({ id: 'H1', ownerAgent: 'agent-A', kind: 'packer' }),
        makeH({ id: 'H2', ownerAgent: 'agent-B', kind: 'packer' }),
      ],
      [
        makeEv({
          id: 'E1',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
        }),
        makeEv({
          id: 'E2',
          round: 1,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
        }),
        makeEv({
          id: 'E3',
          round: 3,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
        }),
      ],
    )
    const { perAgentInbox } = propagate(ledger, [A, B], 2)
    // currentRound=2 ⇒ only round=1 evidence.
    const ids = perAgentInbox.get('agent-B')!.newEvidenceForMe.map(e => e.id)
    expect(ids).toEqual(['E2'])
  })
})

/* -------------------------------------------------------------------------- */
/* Inbox cap (R9-6) + verdict ordering (R9-7)                                 */
/* -------------------------------------------------------------------------- */

describe('propagate — inbox cap + verdict ordering', () => {
  test('cap = 5: ≥ 6 relevant evidences truncated, confirms surface first', () => {
    // Build an evidence set with 4 inconclusives, 1 falsifies, 2 confirms — 7 total.
    // After sort: 2 confirms + 1 falsifies + 4 inconclusives → cap to 5 ⇒
    // [confirms, confirms, falsifies, inconclusive, inconclusive].
    const ledger = ledgerWith(
      [
        makeH({ id: 'H1', ownerAgent: 'agent-A', kind: 'packer' }),
        makeH({ id: 'H2', ownerAgent: 'agent-B', kind: 'packer' }),
      ],
      [
        makeEv({
          id: 'E1',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
          verdict: 'inconclusive',
        }),
        makeEv({
          id: 'E2',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
          verdict: 'inconclusive',
        }),
        makeEv({
          id: 'E3',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
          verdict: 'confirms',
        }),
        makeEv({
          id: 'E4',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
          verdict: 'inconclusive',
        }),
        makeEv({
          id: 'E5',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
          verdict: 'falsifies',
        }),
        makeEv({
          id: 'E6',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
          verdict: 'confirms',
        }),
        makeEv({
          id: 'E7',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
          verdict: 'inconclusive',
        }),
      ],
    )
    const { perAgentInbox } = propagate(ledger, [A, B], 1)
    const inbox = perAgentInbox.get('agent-B')!.newEvidenceForMe
    expect(inbox).toHaveLength(5)
    // Top 2 must be confirms, then falsifies, then 2 inconclusives.
    expect(inbox[0]!.verdict).toBe('confirms')
    expect(inbox[1]!.verdict).toBe('confirms')
    expect(inbox[2]!.verdict).toBe('falsifies')
    expect(inbox[3]!.verdict).toBe('inconclusive')
    expect(inbox[4]!.verdict).toBe('inconclusive')
  })

  test('verdict ordering: confirms before falsifies before mutates before inconclusive', () => {
    const ledger = ledgerWith(
      [
        makeH({ id: 'H1', ownerAgent: 'agent-A', kind: 'packer' }),
        makeH({ id: 'H2', ownerAgent: 'agent-B', kind: 'packer' }),
      ],
      [
        makeEv({
          id: 'E1',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
          verdict: 'inconclusive',
        }),
        makeEv({
          id: 'E2',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
          verdict: 'mutates',
        }),
        makeEv({
          id: 'E3',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
          verdict: 'falsifies',
        }),
        makeEv({
          id: 'E4',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
          verdict: 'confirms',
        }),
      ],
    )
    const { perAgentInbox } = propagate(ledger, [A, B], 1)
    const order = perAgentInbox
      .get('agent-B')!
      .newEvidenceForMe.map(e => e.verdict)
    expect(order).toEqual(['confirms', 'falsifies', 'mutates', 'inconclusive'])
  })
})

/* -------------------------------------------------------------------------- */
/* Stale notice                                                               */
/* -------------------------------------------------------------------------- */

describe('propagate — staleNotice', () => {
  test('stale H ⇒ owner inbox.staleNotice contains the id', () => {
    const ledger = ledgerWith([
      makeH({ id: 'H1', ownerAgent: 'agent-A', status: 'stale' }),
      makeH({ id: 'H2', ownerAgent: 'agent-B', status: 'stale' }),
    ])
    const { perAgentInbox } = propagate(ledger, [A, B], 1)
    expect(perAgentInbox.get('agent-A')!.staleNotice).toEqual(['H1'])
    expect(perAgentInbox.get('agent-B')!.staleNotice).toEqual(['H2'])
  })

  test('only stale H surface; open / evidence / falsified / mutated are not in staleNotice', () => {
    const ledger = ledgerWith([
      makeH({ id: 'H1', ownerAgent: 'agent-A', status: 'open' }),
      makeH({ id: 'H2', ownerAgent: 'agent-A', status: 'evidence' }),
      makeH({ id: 'H3', ownerAgent: 'agent-A', status: 'falsified' }),
      makeH({ id: 'H4', ownerAgent: 'agent-A', status: 'mutated' }),
      makeH({ id: 'H5', ownerAgent: 'agent-A', status: 'stale' }),
    ])
    const { perAgentInbox } = propagate(ledger, [A], 1)
    expect(perAgentInbox.get('agent-A')!.staleNotice).toEqual(['H5'])
  })

  test("stale H whose owner is not in the agents list is silently dropped", () => {
    const ledger = ledgerWith([
      makeH({ id: 'H1', ownerAgent: 'ghost-agent', status: 'stale' }),
    ])
    const { perAgentInbox } = propagate(ledger, [A], 1)
    expect(perAgentInbox.get('agent-A')!.staleNotice).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* DERIVE_RULES vertical hint generation                                      */
/* -------------------------------------------------------------------------- */

describe('propagate — sub-hypothesis hint generation (R9-4)', () => {
  test("packer promoted last round ⇒ owner gets compiler + capability hints", () => {
    const ledger = ledgerWith([
      makeH({
        id: 'H1',
        ownerAgent: 'agent-A',
        kind: 'packer',
        status: 'evidence',
        lastTouchedRound: 2,
      }),
    ])
    const { perAgentInbox } = propagate(ledger, [A], 3)
    const hints = perAgentInbox.get('agent-A')!.newHypothesisFromPeer
    // DERIVE_RULES['packer'] = ['compiler', 'capability']
    expect(hints).toHaveLength(2)
    const kinds = hints.map(h => h.kind).sort()
    expect(kinds).toEqual(['capability', 'compiler'])
    for (const h of hints) {
      expect(h.parentId).toBe('H1')
      expect(h.status).toBe('open')
      expect(h.confidence).toBeCloseTo(0.3, 5)
      expect(h.ownerAgent).toBe('agent-A')
      // Synthetic id format: H1.<n>
      expect(h.id.startsWith('H1.')).toBe(true)
      expect(h.id.split('.').length).toBe(2)
    }
  })

  test("terminal kind ('algorithm', 'anti-analysis') yields no hints", () => {
    const cases: HypothesisKind[] = ['algorithm', 'anti-analysis']
    for (const kind of cases) {
      const ledger = ledgerWith([
        makeH({
          id: 'H1',
          ownerAgent: 'agent-A',
          kind,
          status: 'evidence',
          lastTouchedRound: 0,
        }),
      ])
      const { perAgentInbox } = propagate(ledger, [A], 1)
      const hints = perAgentInbox.get('agent-A')!.newHypothesisFromPeer
      expect(hints).toHaveLength(0)
    }
  })

  test("DERIVE_RULES expansion only fires for promotion in currentRound-1", () => {
    // Promoted in round 0, currentRound is 5 ⇒ no fresh hint.
    const ledger = ledgerWith([
      makeH({
        id: 'H1',
        ownerAgent: 'agent-A',
        kind: 'packer',
        status: 'evidence',
        lastTouchedRound: 0,
      }),
    ])
    const { perAgentInbox } = propagate(ledger, [A], 5)
    expect(
      perAgentInbox.get('agent-A')!.newHypothesisFromPeer,
    ).toHaveLength(0)
  })

  test('depth-cap: H1.2.3.4 (depth 4) is NOT expanded further', () => {
    const ledger = ledgerWith([
      makeH({
        id: 'H1.2.3.4',
        ownerAgent: 'agent-A',
        kind: 'packer',
        status: 'evidence',
        lastTouchedRound: 0,
      }),
    ])
    const { perAgentInbox } = propagate(ledger, [A], 1)
    expect(
      perAgentInbox.get('agent-A')!.newHypothesisFromPeer,
    ).toHaveLength(0)
  })

  test("synthetic child id avoids collisions with existing children", () => {
    // H1 already has H1.1 and H1.2. The propagator must mint H1.3, H1.4
    // for the two derived child kinds.
    const ledger = ledgerWith([
      makeH({
        id: 'H1',
        ownerAgent: 'agent-A',
        kind: 'packer',
        status: 'evidence',
        lastTouchedRound: 0,
      }),
      makeH({ id: 'H1.1', parentId: 'H1', ownerAgent: 'agent-A' }),
      makeH({ id: 'H1.2', parentId: 'H1', ownerAgent: 'agent-A' }),
    ])
    const { perAgentInbox } = propagate(ledger, [A], 1)
    const ids = perAgentInbox
      .get('agent-A')!
      .newHypothesisFromPeer.map(h => h.id)
      .sort()
    expect(ids).toEqual(['H1.3', 'H1.4'])
  })
})

/* -------------------------------------------------------------------------- */
/* DERIVE_RULES — table consistency                                           */
/* -------------------------------------------------------------------------- */

describe('DERIVE_RULES — table contents', () => {
  test('every HypothesisKind has an entry', () => {
    const kinds: HypothesisKind[] = [
      'file-class',
      'packer',
      'compiler',
      'family',
      'algorithm',
      'anti-analysis',
      'capability',
      'protocol',
    ]
    for (const k of kinds) {
      expect(DERIVE_RULES[k]).toBeDefined()
    }
  })

  test('terminal kinds map to empty arrays', () => {
    expect(DERIVE_RULES.algorithm).toEqual([])
    expect(DERIVE_RULES['anti-analysis']).toEqual([])
  })

  test('protocol derives capability (non-terminal)', () => {
    expect(DERIVE_RULES.protocol).toEqual(['capability'])
  })

  test('packer derives compiler + capability', () => {
    expect([...DERIVE_RULES.packer].sort()).toEqual(['capability', 'compiler'])
  })

  test('file-class derives packer + compiler + capability', () => {
    expect([...DERIVE_RULES['file-class']].sort()).toEqual([
      'capability',
      'compiler',
      'packer',
    ])
  })
})

/* -------------------------------------------------------------------------- */
/* Purity                                                                     */
/* -------------------------------------------------------------------------- */

describe('propagate — purity', () => {
  test('input ledger is not mutated', () => {
    const ledger = ledgerWith(
      [
        makeH({ id: 'H1', ownerAgent: 'agent-A', kind: 'packer' }),
        makeH({ id: 'H2', ownerAgent: 'agent-B', kind: 'packer' }),
      ],
      [
        makeEv({
          id: 'E1',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
        }),
      ],
    )
    const beforeHSize = ledger.hypotheses.size
    const beforeESize = ledger.evidenceLog.length
    propagate(ledger, [A, B], 1)
    expect(ledger.hypotheses.size).toBe(beforeHSize)
    expect(ledger.evidenceLog.length).toBe(beforeESize)
  })

  test('two calls with identical inputs produce structurally identical outputs', () => {
    const ledger = ledgerWith(
      [
        makeH({ id: 'H1', ownerAgent: 'agent-A', kind: 'packer' }),
        makeH({ id: 'H2', ownerAgent: 'agent-B', kind: 'packer' }),
      ],
      [
        makeEv({
          id: 'E1',
          round: 0,
          agentId: 'agent-A',
          testedHypothesis: 'H1',
        }),
      ],
    )
    const r1 = propagate(ledger, [A, B], 1)
    const r2 = propagate(ledger, [A, B], 1)
    const flatten = (m: ReadonlyMap<string, AgentInbox>) =>
      [...m.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [
          k,
          v.newEvidenceForMe.map(e => e.id),
          v.newHypothesisFromPeer.map(h => h.id),
          [...v.staleNotice],
        ])
    expect(flatten(r1.perAgentInbox)).toEqual(flatten(r2.perAgentInbox))
  })
})

/* -------------------------------------------------------------------------- */
/* PBT — Property 10 across random configurations                             */
/* -------------------------------------------------------------------------- */

/**
 * Property 10 (Self-reflexive invariance):
 * For ANY ledger configuration of agents + active hypotheses + evidence
 * pushed in `currentRound - 1`, the resulting `newEvidenceForMe` for an
 * agent A NEVER contains any evidence whose `agentId === A`.
 *
 * Validates: Requirements 9.8
 */
describe('PBT — Property 10: self-reflexive invariance over random inputs', () => {
  const KINDS: readonly HypothesisKind[] = [
    'file-class',
    'packer',
    'compiler',
    'family',
    'algorithm',
    'anti-analysis',
    'capability',
    'protocol',
  ]
  const VERDICTS: readonly Verdict[] = [
    'confirms',
    'falsifies',
    'mutates',
    'inconclusive',
  ]
  const AGENT_IDS = ['agent-A', 'agent-B', 'agent-C', 'agent-D']

  type EvSpec = {
    agentId: string
    testedHypothesis: string
    verdict: Verdict
  }

  const hypothesisArb = fc.record({
    idIndex: fc.integer({ min: 1, max: 8 }),
    ownerAgent: fc.constantFrom(...AGENT_IDS),
    kind: fc.constantFrom(...KINDS),
  })

  const evArb: fc.Arbitrary<EvSpec> = fc.record({
    agentId: fc.constantFrom(...AGENT_IDS),
    testedHypothesis: fc
      .integer({ min: 1, max: 8 })
      .map(n => `H${n}`),
    verdict: fc.constantFrom(...VERDICTS),
  })

  test('for any inputs, no agent receives self-produced evidence', () => {
    fc.assert(
      fc.property(
        fc.array(hypothesisArb, { minLength: 1, maxLength: 8 }),
        fc.array(evArb, { maxLength: 12 }),
        (hSpecs, evSpecs) => {
          // Build hypotheses (deduplicated by id, last wins).
          const hMap = new Map<string, Hypothesis>()
          for (const spec of hSpecs) {
            hMap.set(
              `H${spec.idIndex}`,
              makeH({
                id: `H${spec.idIndex}`,
                ownerAgent: spec.ownerAgent,
                kind: spec.kind,
                status: 'open',
              }),
            )
          }

          // Build evidence; only those whose testedHypothesis exists in
          // the ledger can route by kind.
          const evidence: ToolEvidence[] = evSpecs.map((spec, i) =>
            makeEv({
              id: `E${i + 1}`,
              round: 0,
              agentId: spec.agentId,
              testedHypothesis: spec.testedHypothesis,
              verdict: spec.verdict,
            }),
          )

          const ledger: SharedLedger = {
            ...createEmptyLedger(24),
            hypotheses: hMap,
            evidenceLog: evidence,
            lastEvidenceId: evidence.length,
          }
          const agents: AgentDescriptor[] = AGENT_IDS.map(id => ({ id }))
          const { perAgentInbox } = propagate(ledger, agents, 1)

          for (const [agentId, inbox] of perAgentInbox) {
            for (const ev of inbox.newEvidenceForMe) {
              // The central invariant: no agent ever receives its own
              // evidence as "newEvidenceForMe".
              if (ev.agentId === agentId) return false
            }
          }
          return true
        },
      ),
      { numRuns: 200 },
    )
  })
})

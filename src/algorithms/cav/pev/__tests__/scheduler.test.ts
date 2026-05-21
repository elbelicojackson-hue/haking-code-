/**
 * Scheduler — unit tests for Algorithm 1.
 *
 * Coverage map (per task T7 DoD + Properties 7, 8):
 *   - Property 7: when every agent has no candidate (empty active-own
 *     set OR all candidates already touched this round), the result's
 *     `stallGuardWarning` is `true`.
 *   - Property 8: stale hypotheses (cascaded by the ledger) are NEVER
 *     selected by the scheduler.
 *   - Single agent + one open H ⇒ directive contains
 *     `suggestedToolPlanId`.
 *   - All plans for a kind exhausted (one evidence per tool) ⇒ hint
 *     `'all plans exhausted'`, no `suggestedToolPlanId`.
 *   - Highest confidence wins; tie-break by id ascending (R7-6).
 *   - `lastTouchedRound === currentRound` excludes a candidate.
 *   - falsified / mutated hypotheses are not selected.
 *   - Multiple agents get independent directives.
 *   - Pure function: identical inputs produce structurally identical
 *     outputs and the input ledger is never mutated.
 *   - Empty agent list returns no warning (vacuously `false`).
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.6, 7.7, 7.8, 7.9
 */

import { describe, expect, test } from 'bun:test'
import { CANONICAL_TESTS } from '../canonicalTests.js'
import {
  type Hypothesis,
  type SharedLedger,
  type ToolEvidence,
  applyStaleCascade,
  createEmptyLedger,
} from '../ledger.js'
import {
  type AgentDescriptor,
  type ScheduleDirective,
  schedule,
} from '../scheduler.js'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** Build a Hypothesis with sensible defaults; tests override what they need. */
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

/** Build a ledger pre-populated with the given hypotheses + evidence. */
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

/** Helper to construct an evidence record. */
function ev(
  id: string,
  testedHypothesis: string,
  toolName: string,
): ToolEvidence {
  return {
    id,
    agentId: 'agent-A',
    round: 0,
    toolName,
    toolArgs: {},
    outcome: 'success',
    resultDigest: '...',
    testedHypothesis,
    verdict: 'confirms',
    durationMs: 10,
  }
}

const AGENT_A: AgentDescriptor = { id: 'agent-A' }
const AGENT_B: AgentDescriptor = { id: 'agent-B' }

/* -------------------------------------------------------------------------- */
/* Single agent — happy paths                                                 */
/* -------------------------------------------------------------------------- */

describe('schedule — single agent, one open hypothesis', () => {
  test('emits a directive with suggestedHypothesisId + suggestedToolPlanId', () => {
    const h = makeH({
      id: 'H1',
      kind: 'packer',
      ownerAgent: 'agent-A',
      confidence: 0.7,
      lastTouchedRound: 0,
    })
    const ledger = ledgerWith([h])
    const { perAgentDirective, stallGuardWarning } = schedule(
      ledger,
      [AGENT_A],
      1,
    )
    expect(stallGuardWarning).toBe(false)
    const d = perAgentDirective.get('agent-A')!
    expect(d).toBeDefined()
    expect(d.suggestedHypothesisId).toBe('H1')
    expect(typeof d.suggestedToolPlanId).toBe('string')
    // The plan id must come from the canonical table and target the H's kind.
    const plan = CANONICAL_TESTS[d.suggestedToolPlanId!]
    expect(plan).toBeDefined()
    expect(plan!.kind).toBe('packer')
  })

  test('evidence-status H is also a candidate (not just open)', () => {
    const h = makeH({ id: 'H1', status: 'evidence', confidence: 0.9 })
    const ledger = ledgerWith([h])
    const { perAgentDirective } = schedule(ledger, [AGENT_A], 1)
    const d = perAgentDirective.get('agent-A')!
    expect(d.suggestedHypothesisId).toBe('H1')
    expect(d.suggestedToolPlanId).toBeDefined()
  })
})

/* -------------------------------------------------------------------------- */
/* Property 7 — stall guard                                                   */
/* -------------------------------------------------------------------------- */

describe('schedule — Property 7: stall guard', () => {
  test('every agent has no own active H ⇒ stallGuardWarning=true', () => {
    const ledger = ledgerWith([])
    const { perAgentDirective, stallGuardWarning } = schedule(
      ledger,
      [AGENT_A, AGENT_B],
      1,
    )
    expect(stallGuardWarning).toBe(true)
    expect(perAgentDirective.get('agent-A')!.hint).toBe(
      'no own active H, observe',
    )
    expect(perAgentDirective.get('agent-B')!.hint).toBe(
      'no own active H, observe',
    )
    // No tool plan suggested anywhere.
    for (const d of perAgentDirective.values()) {
      expect(d.suggestedToolPlanId).toBeUndefined()
      expect(d.suggestedHypothesisId).toBeUndefined()
    }
  })

  test('every agent has only touched-this-round H ⇒ stallGuardWarning=true', () => {
    const ledger = ledgerWith([
      makeH({
        id: 'H1',
        ownerAgent: 'agent-A',
        lastTouchedRound: 3,
      }),
      makeH({
        id: 'H2',
        ownerAgent: 'agent-B',
        lastTouchedRound: 3,
      }),
    ])
    // Use greedy-confidence strategy to bypass Theorem 1 suppression
    // (legacy behavior preserved for backward compat)
    const { stallGuardWarning, perAgentDirective } = schedule(
      ledger,
      [AGENT_A, AGENT_B],
      3,
      undefined,
      'greedy-confidence',
    )
    expect(stallGuardWarning).toBe(true)
    expect(perAgentDirective.get('agent-A')!.hint).toBe(
      'all touched, observe',
    )
    expect(perAgentDirective.get('agent-B')!.hint).toBe(
      'all touched, observe',
    )
  })

  test('mixed: one agent has work ⇒ stallGuardWarning=false', () => {
    const ledger = ledgerWith([
      makeH({ id: 'H1', ownerAgent: 'agent-A', lastTouchedRound: 0 }),
      // agent-B has nothing.
    ])
    const { stallGuardWarning } = schedule(ledger, [AGENT_A, AGENT_B], 1)
    expect(stallGuardWarning).toBe(false)
  })

  test('empty agent list ⇒ stallGuardWarning=false (vacuous)', () => {
    const ledger = ledgerWith([])
    const { stallGuardWarning, perAgentDirective } = schedule(ledger, [], 1)
    expect(stallGuardWarning).toBe(false)
    expect(perAgentDirective.size).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Plan exhaustion                                                            */
/* -------------------------------------------------------------------------- */

describe('schedule — plan exhaustion', () => {
  test('all plans for a kind already tested ⇒ hint="all plans exhausted"', () => {
    // For the 'packer' kind we know there are at least 3 plans whose tools
    // are a subset of {ReverseCli, Bash}. We synthesize one evidence per
    // distinct tool used by packer plans to exhaust them all.
    const packerPlans = Object.values(CANONICAL_TESTS).filter(
      p => p.kind === 'packer',
    )
    const distinctTools = Array.from(new Set(packerPlans.map(p => p.tool)))

    const h = makeH({ id: 'H1', kind: 'packer' })
    const evidenceLog: ToolEvidence[] = distinctTools.map((t, idx) =>
      ev(`E${idx + 1}`, 'H1', t),
    )

    const ledger = ledgerWith([h], evidenceLog)
    const { perAgentDirective, stallGuardWarning } = schedule(
      ledger,
      [AGENT_A],
      1,
    )
    const d = perAgentDirective.get('agent-A')!
    expect(d.hint).toBe('all plans exhausted')
    expect(d.suggestedToolPlanId).toBeUndefined()
    expect(d.suggestedHypothesisId).toBe('H1')
    // Plan-exhaustion is NOT a stall (we DID identify a target H).
    expect(stallGuardWarning).toBe(false)
  })

  test('partial exhaustion ⇒ next untested plan is suggested', () => {
    // Mark 'ReverseCli' as already tested for H1; the scheduler should pick
    // a packer plan whose tool is NOT ReverseCli (e.g. packer::vmprotect-probe
    // uses Bash).
    const h = makeH({ id: 'H1', kind: 'packer' })
    const ledger = ledgerWith([h], [ev('E1', 'H1', 'ReverseCli')])
    const { perAgentDirective } = schedule(ledger, [AGENT_A], 1)
    const d = perAgentDirective.get('agent-A')!
    expect(d.suggestedToolPlanId).toBeDefined()
    const plan = CANONICAL_TESTS[d.suggestedToolPlanId!]
    expect(plan!.tool).not.toBe('ReverseCli')
  })
})

/* -------------------------------------------------------------------------- */
/* Confidence ranking + tie-break                                             */
/* -------------------------------------------------------------------------- */

describe('schedule — confidence ranking', () => {
  test('highest confidence wins among an agent\'s active hypotheses', () => {
    const ledger = ledgerWith([
      makeH({ id: 'H1', confidence: 0.3, ownerAgent: 'agent-A' }),
      makeH({ id: 'H2', confidence: 0.9, ownerAgent: 'agent-A' }),
      makeH({ id: 'H3', confidence: 0.5, ownerAgent: 'agent-A' }),
    ])
    const { perAgentDirective } = schedule(ledger, [AGENT_A], 1, undefined, 'greedy-confidence')
    expect(perAgentDirective.get('agent-A')!.suggestedHypothesisId).toBe('H2')
  })

  test('ties on confidence are broken by id ascending (R7-6)', () => {
    const ledger = ledgerWith([
      makeH({ id: 'H3', confidence: 0.7, ownerAgent: 'agent-A' }),
      makeH({ id: 'H1', confidence: 0.7, ownerAgent: 'agent-A' }),
      makeH({ id: 'H2', confidence: 0.7, ownerAgent: 'agent-A' }),
    ])
    const { perAgentDirective } = schedule(ledger, [AGENT_A], 1, undefined, 'greedy-confidence')
    expect(perAgentDirective.get('agent-A')!.suggestedHypothesisId).toBe('H1')
  })
})

/* -------------------------------------------------------------------------- */
/* lastTouchedRound exclusion                                                 */
/* -------------------------------------------------------------------------- */

describe('schedule — lastTouchedRound exclusion', () => {
  test('lastTouchedRound === currentRound is excluded from candidates', () => {
    const ledger = ledgerWith([
      // Touched this round — must be filtered out.
      makeH({ id: 'H1', confidence: 0.95, lastTouchedRound: 5 }),
      // Not touched this round — must be selected.
      makeH({ id: 'H2', confidence: 0.6, lastTouchedRound: 4 }),
    ])
    const { perAgentDirective } = schedule(ledger, [AGENT_A], 5)
    expect(perAgentDirective.get('agent-A')!.suggestedHypothesisId).toBe('H2')
  })

  test('lastTouchedRound > currentRound is also excluded (defence)', () => {
    // Pathological but should not crash: if a future round number leaks
    // into the ledger, filter still says "touched".
    const ledger = ledgerWith([
      makeH({ id: 'H1', lastTouchedRound: 9 }),
      makeH({ id: 'H2', lastTouchedRound: 0 }),
    ])
    const { perAgentDirective } = schedule(ledger, [AGENT_A], 5)
    expect(perAgentDirective.get('agent-A')!.suggestedHypothesisId).toBe('H2')
  })
})

/* -------------------------------------------------------------------------- */
/* Property 8 — stale / falsified / mutated never selected                    */
/* -------------------------------------------------------------------------- */

describe('schedule — Property 8: stale H is not selected', () => {
  test('cascade-staled H is excluded; sibling subtree still scheduled', () => {
    // Tree:
    //   H1 (falsified)
    //     ├─ H1.1 (open) → gets staled by cascade
    //     └─ H1.2 (open) → gets staled by cascade
    //   H2 (open) → unaffected
    const before = ledgerWith([
      makeH({
        id: 'H1',
        ownerAgent: 'agent-A',
        status: 'falsified',
        confidence: 0,
      }),
      makeH({
        id: 'H1.1',
        parentId: 'H1',
        ownerAgent: 'agent-A',
        status: 'open',
        confidence: 0.9,
      }),
      makeH({
        id: 'H1.2',
        parentId: 'H1',
        ownerAgent: 'agent-A',
        status: 'open',
        confidence: 0.95,
      }),
      makeH({
        id: 'H2',
        ownerAgent: 'agent-A',
        status: 'open',
        confidence: 0.4,
      }),
    ])
    const after = applyStaleCascade(before, 'H1')

    const { perAgentDirective, stallGuardWarning } = schedule(
      after,
      [AGENT_A],
      1,
    )
    expect(stallGuardWarning).toBe(false)
    // Highest confidence overall is H1.2 (0.95) but it's stale; H1.1 is
    // also stale. Falsified H1 is also excluded. Only H2 (0.4) remains.
    expect(perAgentDirective.get('agent-A')!.suggestedHypothesisId).toBe('H2')
  })

  test('falsified H is not selected even without cascade', () => {
    const ledger = ledgerWith([
      makeH({ id: 'H1', status: 'falsified', confidence: 0 }),
      makeH({ id: 'H2', status: 'open', confidence: 0.5 }),
    ])
    const { perAgentDirective } = schedule(ledger, [AGENT_A], 1)
    expect(perAgentDirective.get('agent-A')!.suggestedHypothesisId).toBe('H2')
  })

  test('mutated H is not selected (the new_id replaces it)', () => {
    const ledger = ledgerWith([
      makeH({ id: 'H1', status: 'mutated', confidence: 0.9 }),
      makeH({ id: 'H1b', status: 'open', confidence: 0.6 }),
    ])
    const { perAgentDirective } = schedule(ledger, [AGENT_A], 1)
    expect(perAgentDirective.get('agent-A')!.suggestedHypothesisId).toBe('H1b')
  })

  test('all of one agent\'s H are stale ⇒ observer hint, not exhausted', () => {
    const ledger = ledgerWith([
      makeH({ id: 'H1', status: 'stale' }),
      makeH({ id: 'H2', status: 'falsified' }),
      makeH({ id: 'H3', status: 'mutated' }),
    ])
    const { perAgentDirective, stallGuardWarning } = schedule(
      ledger,
      [AGENT_A],
      1,
    )
    expect(perAgentDirective.get('agent-A')!.hint).toBe(
      'no own active H, observe',
    )
    expect(stallGuardWarning).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Multi-agent independence                                                   */
/* -------------------------------------------------------------------------- */

describe('schedule — multi-agent independence', () => {
  test('each agent only sees their own active H', () => {
    const ledger = ledgerWith([
      makeH({ id: 'H1', ownerAgent: 'agent-A', kind: 'packer', confidence: 0.8 }),
      makeH({ id: 'H2', ownerAgent: 'agent-B', kind: 'compiler', confidence: 0.6 }),
    ])
    const { perAgentDirective } = schedule(ledger, [AGENT_A, AGENT_B], 1)

    const dA = perAgentDirective.get('agent-A')!
    const dB = perAgentDirective.get('agent-B')!
    expect(dA.suggestedHypothesisId).toBe('H1')
    expect(dB.suggestedHypothesisId).toBe('H2')

    const planA = CANONICAL_TESTS[dA.suggestedToolPlanId!]
    const planB = CANONICAL_TESTS[dB.suggestedToolPlanId!]
    expect(planA!.kind).toBe('packer')
    expect(planB!.kind).toBe('compiler')
  })

  test('agent with no H gets observer hint while another agent gets work', () => {
    const ledger = ledgerWith([
      makeH({ id: 'H1', ownerAgent: 'agent-A', confidence: 0.5 }),
    ])
    const { perAgentDirective, stallGuardWarning } = schedule(
      ledger,
      [AGENT_A, AGENT_B],
      1,
    )
    expect(stallGuardWarning).toBe(false)
    expect(perAgentDirective.get('agent-A')!.suggestedHypothesisId).toBe('H1')
    expect(perAgentDirective.get('agent-B')!.hint).toBe(
      'no own active H, observe',
    )
  })

  test('directive map contains exactly one entry per unique agent id', () => {
    const ledger = ledgerWith([])
    const agents = [AGENT_A, AGENT_B, { id: 'agent-C' }]
    const { perAgentDirective } = schedule(ledger, agents, 1)
    expect(perAgentDirective.size).toBe(3)
    expect(new Set(perAgentDirective.keys())).toEqual(
      new Set(['agent-A', 'agent-B', 'agent-C']),
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Purity / determinism                                                       */
/* -------------------------------------------------------------------------- */

describe('schedule — purity', () => {
  test('input ledger is not mutated', () => {
    const ledger = ledgerWith([
      makeH({ id: 'H1', confidence: 0.7, lastTouchedRound: 0 }),
    ])
    const beforeSize = ledger.hypotheses.size
    const beforeEvidence = ledger.evidenceLog.length
    const beforeBudget = ledger.toolBudgetRemaining
    schedule(ledger, [AGENT_A], 1)
    expect(ledger.hypotheses.size).toBe(beforeSize)
    expect(ledger.evidenceLog.length).toBe(beforeEvidence)
    expect(ledger.toolBudgetRemaining).toBe(beforeBudget)
  })

  test('two calls with identical inputs produce structurally identical outputs', () => {
    const ledger = ledgerWith([
      makeH({ id: 'H1', confidence: 0.6 }),
      makeH({ id: 'H2', confidence: 0.8 }),
    ])
    const r1 = schedule(ledger, [AGENT_A], 1)
    const r2 = schedule(ledger, [AGENT_A], 1)
    // Convert maps to sorted arrays so equality is deterministic.
    const toArr = (
      m: ReadonlyMap<string, ScheduleDirective>,
    ): Array<[string, ScheduleDirective]> =>
      [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
    expect(toArr(r1.perAgentDirective)).toEqual(toArr(r2.perAgentDirective))
    expect(r1.stallGuardWarning).toBe(r2.stallGuardWarning)
  })
})

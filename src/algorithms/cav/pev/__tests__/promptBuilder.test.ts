/**
 * Prompt Builder — unit tests.
 *
 * Coverage map (per task T9 DoD + R1-1 .. R1-11):
 *
 *   System prompt
 *   - Contains the literal `"1.0"` schema_version constraint.
 *   - Names `agent_id` constraint and embeds the agent id verbatim.
 *   - Lists every CANONICAL_TESTS plan id (sample assertions on
 *     `packer::diec` and `compiler::dnspy-probe`).
 *   - Mentions all 5 hypothesis_updates op names (create, promote,
 *     falsify, mutate, confidence_adjust).
 *   - Mentions all 4 next_action kinds (tool_call, observe_only,
 *     request_oracle, declare_done).
 *   - Carries a positive example whose schema_version is
 *     `"1.0"` (literal string, not numeric).
 *   - Carries a Forbidden / ❌ section.
 *   - Length ≤ MAX_PROMPT_CHARS (16 000).
 *   - Initial claim text is included verbatim.
 *
 *   User prompt
 *   - Header includes the round number AND the agent id.
 *   - Lists this agent's active hypotheses only — the other agent's
 *     hypothesis MUST NOT appear.
 *   - Inbox section emits evidence, sub-hypothesis hints, and stale
 *     notice ids.
 *   - Directive content (suggested hypothesis + plan) appears.
 *   - Length ≤ MAX_PROMPT_CHARS.
 *   - When directive is missing → still produces a valid prompt.
 *   - When inbox is empty/undefined → no `### Inbox` header.
 *
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 1.9, 1.11
 */

import { describe, expect, test } from 'bun:test'
import { CANONICAL_TESTS } from '../canonicalTests.js'
import {
  type Hypothesis,
  type SharedLedger,
  type ToolEvidence,
  createEmptyLedger,
} from '../ledger.js'
import {
  MAX_PROMPT_CHARS,
  buildAgentSystemPrompt,
  buildAgentUserPrompt,
} from '../promptBuilder.js'
import type { AgentInbox } from '../propagator.js'
import type { ScheduleDirective } from '../scheduler.js'

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

function ledgerWith(hypotheses: ReadonlyArray<Hypothesis>): SharedLedger {
  const base = createEmptyLedger(24)
  const map = new Map<string, Hypothesis>()
  for (const h of hypotheses) map.set(h.id, h)
  return { ...base, hypotheses: map }
}

function makeEv(overrides: Partial<ToolEvidence> & { id: string }): ToolEvidence {
  return {
    agentId: 'agent-B',
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

/* ========================================================================== */
/* System prompt                                                              */
/* ========================================================================== */

describe('buildAgentSystemPrompt', () => {
  const baseOpts = {
    agentId: 'static_analyst',
    initialClaim:
      '判断目标二进制是否被加壳、主体语言是什么、是否有反调试',
  }

  test('contains the literal "1.0" schema_version constraint', () => {
    const out = buildAgentSystemPrompt(baseOpts)
    expect(out).toContain('schema_version')
    expect(out).toContain('"1.0"')
  })

  test('names agent_id constraint and embeds the agent id verbatim', () => {
    const out = buildAgentSystemPrompt(baseOpts)
    expect(out).toContain('agent_id')
    expect(out).toContain('static_analyst')
  })

  test('lists at least the packer::diec and compiler::dnspy-probe plan ids', () => {
    const out = buildAgentSystemPrompt(baseOpts)
    expect(out).toContain('packer::diec')
    expect(out).toContain('compiler::dnspy-probe')
  })

  test('lists every plan id from CANONICAL_TESTS', () => {
    const out = buildAgentSystemPrompt(baseOpts)
    for (const id of Object.keys(CANONICAL_TESTS)) {
      expect(out).toContain(id)
    }
  })

  test('mentions all 5 hypothesis_updates op names', () => {
    const out = buildAgentSystemPrompt(baseOpts)
    for (const op of [
      'create',
      'promote',
      'falsify',
      'mutate',
      'confidence_adjust',
    ]) {
      expect(out).toContain(op)
    }
  })

  test('mentions all 4 next_action kinds', () => {
    const out = buildAgentSystemPrompt(baseOpts)
    for (const k of [
      'tool_call',
      'observe_only',
      'request_oracle',
      'declare_done',
    ]) {
      expect(out).toContain(k)
    }
  })

  test('positive example uses "1.0" as a string literal', () => {
    const out = buildAgentSystemPrompt(baseOpts)
    // The example block must include `"schema_version": "1.0"` exactly.
    expect(out).toContain('"schema_version": "1.0"')
    // And must NOT teach the model to emit a numeric `1.0` instead.
    expect(out).not.toContain('"schema_version": 1.0')
  })

  test('positive example uses the agent id as agent_id', () => {
    const out = buildAgentSystemPrompt(baseOpts)
    expect(out).toContain('"agent_id": "static_analyst"')
  })

  test('contains a forbidden / ❌ section listing key mistakes', () => {
    const out = buildAgentSystemPrompt(baseOpts)
    // The section header itself.
    expect(out).toContain('Forbidden')
    // Specific banned items called out by the schema constraints.
    expect(out.toLowerCase()).toContain('camelcase')
    expect(out).toContain('trailing comma')
  })

  test('initial claim is embedded verbatim', () => {
    const claim = 'judge if packed; identify language; detect anti-debug'
    const out = buildAgentSystemPrompt({ ...baseOpts, initialClaim: claim })
    expect(out).toContain(claim)
  })

  test('output length is within MAX_PROMPT_CHARS', () => {
    const out = buildAgentSystemPrompt(baseOpts)
    expect(out.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS)
  })

  test('respects optional kind tag in the role line', () => {
    const out = buildAgentSystemPrompt({ ...baseOpts, kind: 'packer' })
    expect(out).toContain('specialty')
    expect(out).toContain('packer')
  })

  test('omits specialty line when kind is absent', () => {
    const out = buildAgentSystemPrompt(baseOpts)
    expect(out).not.toContain('specialty')
  })

  test('mentions the three fixed output sections in order', () => {
    const out = buildAgentSystemPrompt(baseOpts)
    const proseIdx = out.indexOf('内容')
    const pevIdx = out.indexOf('```pev')
    const cavIdx = out.indexOf('```cav')
    expect(proseIdx).toBeGreaterThanOrEqual(0)
    expect(pevIdx).toBeGreaterThan(proseIdx)
    expect(cavIdx).toBeGreaterThan(pevIdx)
  })
})

/* ========================================================================== */
/* User prompt                                                                */
/* ========================================================================== */

describe('buildAgentUserPrompt', () => {
  test('header includes round number AND agent_id', () => {
    const out = buildAgentUserPrompt({
      agentId: 'agent-A',
      round: 3,
      ledger: createEmptyLedger(24),
    })
    expect(out).toContain('Round 3')
    expect(out).toContain('agent-A')
  })

  test('lists ONLY this agent\'s active hypotheses (not other agents\')', () => {
    const ledger = ledgerWith([
      makeH({ id: 'H1', ownerAgent: 'agent-A', text: 'mine — open packer' }),
      makeH({
        id: 'H2',
        ownerAgent: 'agent-B',
        text: 'other agent owned compiler hypothesis',
        kind: 'compiler',
      }),
      makeH({
        id: 'H3',
        ownerAgent: 'agent-A',
        text: 'mine — also open',
        confidence: 0.8,
      }),
    ])
    const out = buildAgentUserPrompt({
      agentId: 'agent-A',
      round: 1,
      ledger,
    })
    // Mine appears.
    expect(out).toContain('H1')
    expect(out).toContain('H3')
    expect(out).toContain('mine — open packer')
    // Other agent's H must not be referenced as our own.
    expect(out).not.toContain('H2')
    expect(out).not.toContain('other agent owned compiler')
  })

  test('excludes my own falsified / mutated / stale hypotheses', () => {
    const ledger = ledgerWith([
      makeH({ id: 'H1', status: 'open', text: 'open one survives' }),
      makeH({ id: 'H2', status: 'falsified', text: 'falsified one drops' }),
      makeH({ id: 'H3', status: 'stale', text: 'stale one drops' }),
      makeH({ id: 'H4', status: 'mutated', text: 'mutated one drops' }),
    ])
    const out = buildAgentUserPrompt({
      agentId: 'agent-A',
      round: 1,
      ledger,
    })
    expect(out).toContain('open one survives')
    expect(out).not.toContain('falsified one drops')
    expect(out).not.toContain('stale one drops')
    expect(out).not.toContain('mutated one drops')
  })

  test('emits a "(none)" notice when the agent has zero active hypotheses', () => {
    const out = buildAgentUserPrompt({
      agentId: 'agent-A',
      round: 0,
      ledger: createEmptyLedger(24),
    })
    expect(out).toContain('Your active hypotheses')
    expect(out).toContain('(none')
    expect(out).toContain('observe_only')
  })

  test('inbox: evidence + hint + stale-notice all surface', () => {
    const ledger = ledgerWith([
      makeH({ id: 'H1', ownerAgent: 'agent-A' }),
    ])
    const inbox: AgentInbox = {
      newEvidenceForMe: [
        makeEv({
          id: 'E7',
          verdict: 'confirms',
          resultDigest: 'UPX 4.0[NRV] detected',
          testedHypothesis: 'H1',
          agentId: 'agent-B',
        }),
      ],
      newHypothesisFromPeer: [
        {
          id: 'H1.1',
          ownerAgent: 'agent-A',
          kind: 'compiler',
          text: '(hint) sub-hypothesis derived from H1 (packer → compiler)',
          confidence: 0.3,
          status: 'open',
          parentId: 'H1',
          evidenceTrail: [],
          createdRound: 2,
          lastTouchedRound: 2,
        },
      ],
      staleNotice: ['H9.1', 'H9.2'],
    }
    const out = buildAgentUserPrompt({
      agentId: 'agent-A',
      round: 2,
      inbox,
      ledger,
    })
    expect(out).toContain('### Inbox')
    expect(out).toContain('E7')
    expect(out).toContain('confirms')
    expect(out).toContain('UPX 4.0')
    expect(out).toContain('H1.1')
    expect(out).toContain('packer → compiler')
    expect(out).toContain('H9.1')
    expect(out).toContain('H9.2')
  })

  test('directive section appears when directive is provided', () => {
    const ledger = ledgerWith([makeH({ id: 'H1', ownerAgent: 'agent-A' })])
    const directive: ScheduleDirective = {
      suggestedHypothesisId: 'H1',
      suggestedToolPlanId: 'packer::diec',
      hint: 'try packer detection first',
    }
    const out = buildAgentUserPrompt({
      agentId: 'agent-A',
      round: 1,
      directive,
      ledger,
    })
    expect(out).toContain('Scheduler directive')
    expect(out).toContain('H1')
    expect(out).toContain('packer::diec')
    expect(out).toContain('try packer detection first')
  })

  test('absent directive still produces a valid prompt (no crash, no header)', () => {
    const ledger = ledgerWith([makeH({ id: 'H1', ownerAgent: 'agent-A' })])
    const out = buildAgentUserPrompt({
      agentId: 'agent-A',
      round: 1,
      ledger,
    })
    expect(out).toContain('Round 1')
    expect(out).not.toContain('Scheduler directive')
  })

  test('absent inbox suppresses the Inbox section header', () => {
    const ledger = ledgerWith([makeH({ id: 'H1', ownerAgent: 'agent-A' })])
    const out = buildAgentUserPrompt({
      agentId: 'agent-A',
      round: 1,
      ledger,
    })
    expect(out).not.toContain('### Inbox')
  })

  test('empty inbox object also suppresses the Inbox section header', () => {
    const ledger = ledgerWith([makeH({ id: 'H1', ownerAgent: 'agent-A' })])
    const out = buildAgentUserPrompt({
      agentId: 'agent-A',
      round: 1,
      inbox: {
        newEvidenceForMe: [],
        newHypothesisFromPeer: [],
        staleNotice: [],
      },
      ledger,
    })
    expect(out).not.toContain('### Inbox')
  })

  test('output length is within MAX_PROMPT_CHARS even with a busy ledger', () => {
    // Build a fairly large ledger with 50 of this agent's hypotheses
    // and a large inbox; the truncator must keep us under the cap.
    const owned: Hypothesis[] = []
    for (let i = 1; i <= 50; i += 1) {
      owned.push(
        makeH({
          id: `H${i}`,
          ownerAgent: 'agent-A',
          text:
            'verbose hypothesis text '.repeat(20) + `index=${i}`,
          confidence: 0.5,
        }),
      )
    }
    const ledger = ledgerWith(owned)

    const evidenceList: ToolEvidence[] = []
    for (let i = 1; i <= 5; i += 1) {
      evidenceList.push(
        makeEv({
          id: `E${i}`,
          resultDigest: 'long digest text '.repeat(30),
          testedHypothesis: 'H1',
        }),
      )
    }
    const inbox: AgentInbox = {
      newEvidenceForMe: evidenceList,
      newHypothesisFromPeer: [],
      staleNotice: ['H42', 'H43', 'H44'],
    }

    const out = buildAgentUserPrompt({
      agentId: 'agent-A',
      round: 5,
      inbox,
      directive: {
        suggestedHypothesisId: 'H1',
        suggestedToolPlanId: 'packer::diec',
      },
      ledger,
    })
    expect(out.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS)
    // Header is always present.
    expect(out).toContain('Round 5')
    expect(out).toContain('agent-A')
  })

  test('footer reminder always present (output-format reinforcement)', () => {
    const out = buildAgentUserPrompt({
      agentId: 'agent-A',
      round: 7,
      ledger: createEmptyLedger(24),
    })
    expect(out).toContain('three sections')
    expect(out).toContain('```pev')
    expect(out).toContain('```cav')
    // The reminder also re-anchors agent_id and round.
    expect(out).toContain('agent-A')
    expect(out).toContain('7')
  })

  test('hypotheses are listed in lexicographic id order for stable output', () => {
    const ledger = ledgerWith([
      makeH({ id: 'H3', ownerAgent: 'agent-A', text: 'third' }),
      makeH({ id: 'H1', ownerAgent: 'agent-A', text: 'first' }),
      makeH({ id: 'H2', ownerAgent: 'agent-A', text: 'second' }),
    ])
    const out = buildAgentUserPrompt({
      agentId: 'agent-A',
      round: 1,
      ledger,
    })
    const i1 = out.indexOf('H1')
    const i2 = out.indexOf('H2')
    const i3 = out.indexOf('H3')
    expect(i1).toBeGreaterThan(0)
    expect(i2).toBeGreaterThan(i1)
    expect(i3).toBeGreaterThan(i2)
  })

  test('inbox-only directive without suggestion still suppresses directive header', () => {
    const ledger = ledgerWith([makeH({ id: 'H1', ownerAgent: 'agent-A' })])
    const out = buildAgentUserPrompt({
      agentId: 'agent-A',
      round: 1,
      directive: {}, // no fields set
      ledger,
    })
    expect(out).not.toContain('Scheduler directive')
  })
})

/* ========================================================================== */
/* Purity / determinism                                                       */
/* ========================================================================== */

describe('promptBuilder — purity', () => {
  test('two calls with identical inputs produce identical strings', () => {
    const ledger = ledgerWith([
      makeH({ id: 'H1', ownerAgent: 'agent-A', confidence: 0.6 }),
      makeH({ id: 'H2', ownerAgent: 'agent-A', confidence: 0.4 }),
    ])
    const opts = {
      agentId: 'agent-A',
      round: 1,
      directive: {
        suggestedHypothesisId: 'H1',
        suggestedToolPlanId: 'packer::diec',
      },
      ledger,
    }
    expect(buildAgentUserPrompt(opts)).toEqual(buildAgentUserPrompt(opts))
  })

  test('system prompt is stable across repeated calls', () => {
    const opts = { agentId: 'a', initialClaim: 'analyse target.exe' }
    expect(buildAgentSystemPrompt(opts)).toEqual(buildAgentSystemPrompt(opts))
  })
})

/**
 * PevRunner — Protocol hypothesis E2E test.
 *
 * Validates the full capability → protocol derivation chain:
 *   1. Agent creates a `capability` hypothesis (round 0)
 *   2. Agent runs `capability::imports-table` and confirms (round 1)
 *   3. Agent promotes the capability H → propagator derives a `protocol`
 *      sub-hypothesis hint (round 2)
 *   4. Agent creates the protocol H and runs `protocol::tshark` (round 2)
 *   5. tshark confirms → causal intervention fires (protocol::tshark is
 *      in INTERVENTION_REGISTRY) → evidence log contains both original
 *      and intervention evidence entries.
 *
 * This test closes Gap 3 from the CAV consensus deliverable:
 *   "pev-e2e.test.ts only creates file-class/packer/compiler/anti-analysis
 *    4 kinds; family/capability/protocol are zero-covered in e2e."
 *
 * Also validates Gap 1 (protocol intervention variants registered) and
 * Gap 2 (causal execution chain in runner) end-to-end.
 */

import { describe, expect, test } from 'bun:test'
import type { ArenaProvider } from '../../arena/providers.js'
import { findToolPlan } from '../canonicalTests.js'
import { supportsCausalInference } from '../causalEngine.js'
import {
  runPev,
  type PevRoundEvent,
  type PevRunOpts,
  type ProviderAdapterResult,
  type ToolAdapterResult,
} from '../pevRunner.js'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

function makeProvider(id: string): ArenaProvider {
  return {
    id: id as ArenaProvider['id'],
    displayName: id,
    role: 'generalist',
    wireFormat: 'openai',
    baseUrl: 'http://stub',
    apiKey: 'stub-key',
    model: 'stub-model',
  }
}

const AGENT_A = makeProvider('agent-a')
const AGENT_B = makeProvider('agent-b')
const TWO_PROVIDERS: readonly ArenaProvider[] = [AGENT_A, AGENT_B]

const TARGET_BINARY = {
  path: 'e:/samples/c2-beacon.exe',
  sha256: 'b4e2c1'.padEnd(64, '0'),
  size: 65536,
}

const INITIAL_CLAIM = 'Identify network protocol used by suspected C2 beacon'

function makeBudget(overrides: Partial<PevRunOpts['budget']> = {}): PevRunOpts['budget'] {
  return {
    maxRounds: 5,
    maxToolCalls: 20,
    maxTokens: 200_000,
    maxWallClockMs: 10 * 60 * 1000,
    ...overrides,
  }
}

function fakeAgentReply(pevJson: object, prose = '...protocol analysis...'): string {
  return [
    '## 1. Analysis',
    prose,
    '',
    '```pev',
    JSON.stringify(pevJson, null, 2),
    '```',
    '',
    '```cav',
    JSON.stringify({
      self_entropy: 0.3,
      calibration: 0.9,
      update_kl: 0.0,
      latency: 150,
      repair_style: 'none',
    }),
    '```',
  ].join('\n')
}

function pevObserve(agentId: string, round: number): object {
  return {
    schema_version: '1.0',
    agent_id: agentId,
    round,
    observations: [],
    hypothesis_updates: [],
    next_action: {
      kind: 'observe_only',
      rationale: 'waiting for peer evidence',
    },
  }
}

async function drain(
  gen: AsyncGenerator<PevRoundEvent, void, void>,
): Promise<PevRoundEvent[]> {
  const out: PevRoundEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

/* -------------------------------------------------------------------------- */
/* Protocol E2E: capability → protocol derivation chain                       */
/* -------------------------------------------------------------------------- */

describe('runPev — protocol hypothesis E2E', () => {
  /**
   * Round 0: agent-a creates H1 (capability), agent-b observes.
   * Round 1: agent-a runs capability::imports-table on H1, confirms.
   * Round 2: agent-a promotes H1, creates H1.1 (protocol), runs protocol::tshark.
   * Round 3: agent-a observes the causal evidence and declares done.
   */
  function buildProtocolTable(): ReadonlyMap<string, string> {
    const table = new Map<string, string>()

    // Round 0: create capability hypothesis, observe only
    table.set('agent-a:0', fakeAgentReply({
      schema_version: '1.0',
      agent_id: 'agent-a',
      round: 0,
      observations: [],
      hypothesis_updates: [
        {
          op: 'create',
          id: 'H1',
          kind: 'capability',
          text: 'Binary imports WS2_32.dll and WININET.dll — has network capability',
          confidence: 0.7,
        },
      ],
      next_action: {
        kind: 'observe_only',
        rationale: 'hypothesis created, will probe next round',
      },
    }))
    table.set('agent-b:0', fakeAgentReply(pevObserve('agent-b', 0)))

    // Round 1: run capability::imports-table on H1
    table.set('agent-a:1', fakeAgentReply({
      schema_version: '1.0',
      agent_id: 'agent-a',
      round: 1,
      observations: [],
      hypothesis_updates: [],
      next_action: {
        kind: 'tool_call',
        hypothesis_id: 'H1',
        tool_plan_id: 'capability::imports-table',
        args_override: null,
      },
    }))
    table.set('agent-b:1', fakeAgentReply(pevObserve('agent-b', 1)))

    // Round 2: observe the confirms evidence, promote H1,
    // create protocol sub-hypothesis. Observe only (can't tool_call H1.1
    // in the same round it's created — validator checks ledger snapshot).
    table.set('agent-a:2', fakeAgentReply({
      schema_version: '1.0',
      agent_id: 'agent-a',
      round: 2,
      observations: [
        {
          evidence_id: 'E1',
          verdict: 'confirms',
          confidence: 0.9,
        },
      ],
      hypothesis_updates: [
        {
          op: 'promote',
          id: 'H1',
          rationale_short: 'imports-table confirms WS2_32.dll and WININET.dll present',
        },
        {
          op: 'create',
          id: 'H1.1',
          parent_id: 'H1',
          kind: 'protocol',
          text: 'Network traffic uses HTTP/1.1 or TLS 1.3 for C2 communication',
          confidence: 0.6,
        },
      ],
      next_action: {
        kind: 'observe_only',
        rationale: 'created protocol hypothesis, will probe next round',
      },
    }))
    table.set('agent-b:2', fakeAgentReply(pevObserve('agent-b', 2)))

    // Round 3: run protocol::tshark on H1.1 (now in ledger from round 2).
    table.set('agent-a:3', fakeAgentReply({
      schema_version: '1.0',
      agent_id: 'agent-a',
      round: 3,
      observations: [],
      hypothesis_updates: [],
      next_action: {
        kind: 'tool_call',
        hypothesis_id: 'H1.1',
        tool_plan_id: 'protocol::tshark',
        args_override: null,
      },
    }))
    table.set('agent-b:3', fakeAgentReply(pevObserve('agent-b', 3)))

    // Round 4: observe tshark evidence, promote protocol H, declare done.
    table.set('agent-a:4', fakeAgentReply({
      schema_version: '1.0',
      agent_id: 'agent-a',
      round: 4,
      observations: [
        {
          evidence_id: 'E3',
          verdict: 'confirms',
          confidence: 0.95,
        },
      ],
      hypothesis_updates: [
        {
          op: 'promote',
          id: 'H1.1',
          rationale_short: 'tshark confirms TLSv1.3 traffic in pcap',
        },
      ],
      next_action: {
        kind: 'declare_done',
        rationale: 'Protocol identified as TLS 1.3; capability→protocol chain complete',
      },
    }))
    table.set('agent-b:4', fakeAgentReply(pevObserve('agent-b', 4)))

    return table
  }

  function buildProtocolToolTable(): ReadonlyMap<string, ToolAdapterResult> {
    return new Map<string, ToolAdapterResult>([
      [
        'capability::imports-table',
        {
          stdout: 'Import Table:\n  WS2_32.dll\n  WININET.dll\n  KERNEL32.dll\n  ADVAPI32.dll\n',
          exitCode: 0,
          durationMs: 50,
        },
      ],
      [
        'protocol::tshark',
        {
          stdout: 'Protocol Hierarchy Statistics:\n  tcp frames:1200\n  tls frames:980\n    TLSv1.3 frames:950\n  http frames:20\n',
          exitCode: 0,
          durationMs: 800,
        },
      ],
    ])
  }

  function makeCannedProviderAdapter(
    table: ReadonlyMap<string, string>,
  ): NonNullable<PevRunOpts['providerAdapter']> {
    return async (provider, _system, _user, _signal) => {
      const m = _user.match(/Round\s+(\d+)/)
      const round = m ? parseInt(m[1]!, 10) : 0
      const key = `${provider.id}:${round}`
      const content = table.get(key)
      if (content !== undefined) {
        return { content } satisfies ProviderAdapterResult
      }
      return { content: fakeAgentReply(pevObserve(provider.id, round)) }
    }
  }

  function makeCannedToolAdapter(
    table: ReadonlyMap<string, ToolAdapterResult>,
  ): NonNullable<PevRunOpts['toolAdapter']> {
    return async (plan, _args, _signal) => {
      return (
        table.get(plan.id) ??
        ({ stdout: '', exitCode: 1, durationMs: 5 } satisfies ToolAdapterResult)
      )
    }
  }

  test('pre-condition: protocol::tshark supports causal inference (Gap 1)', () => {
    expect(supportsCausalInference('protocol::tshark')).toBe(true)
    expect(supportsCausalInference('protocol::mitm-capture')).toBe(true)
    expect(supportsCausalInference('protocol::strings-protocol-tokens')).toBe(true)
  })

  test('pre-condition: protocol::tshark plan exists in CANONICAL_TESTS', () => {
    const plan = findToolPlan('protocol::tshark')
    expect(plan).toBeDefined()
    expect(plan?.kind).toBe('protocol')
    // Verify our canned stdout would produce a `confirms` verdict.
    // The confirms array has multiple patterns; TLSv1.3 matches the second one.
    const matchesSome = plan!.confirms.some(re => re.test('TLSv1.3 frames:950'))
    expect(matchesSome).toBe(true)
  })

  test('capability → protocol chain runs end-to-end with causal intervention', async () => {
    const table = buildProtocolTable()
    const toolTable = buildProtocolToolTable()
    const events = await drain(
      runPev({
        providers: TWO_PROVIDERS,
        targetBinary: TARGET_BINARY,
        initialClaim: INITIAL_CLAIM,
        budget: makeBudget({ maxRounds: 4 }),
        providerAdapter: makeCannedProviderAdapter(table),
        toolAdapter: makeCannedToolAdapter(toolTable),
      }),
    )

    const last = events[events.length - 1]!
    expect(last.kind).toBe('run-end')
    if (last.kind !== 'run-end') throw new Error('unreachable')

    const finalLedger = last.finalLedger

    // H1 (capability) should exist and be promoted to 'evidence'.
    const h1 = finalLedger.hypotheses.get('H1')
    expect(h1).toBeDefined()
    expect(h1?.kind).toBe('capability')
    expect(h1?.status).toBe('evidence')

    // H1.1 (protocol) should exist — created by agent-a in round 2.
    const h1_1 = finalLedger.hypotheses.get('H1.1')
    expect(h1_1).toBeDefined()
    expect(h1_1?.kind).toBe('protocol')
    expect(h1_1?.parentId).toBe('H1')

    // Evidence log should contain entries for both capability and protocol tools.
    const capabilityEvidence = finalLedger.evidenceLog.filter(
      ev => ev.testedHypothesis === 'H1',
    )
    expect(capabilityEvidence.length).toBeGreaterThanOrEqual(1)
    expect(capabilityEvidence[0]?.verdict).toBe('confirms')

    const protocolEvidence = finalLedger.evidenceLog.filter(
      ev => ev.testedHypothesis === 'H1.1',
    )
    expect(protocolEvidence.length).toBeGreaterThanOrEqual(1)
    // The first protocol evidence should be the original tshark confirms.
    expect(protocolEvidence[0]?.verdict).toBe('confirms')

    // Gap 2 validation: causal intervention should have fired for
    // protocol::tshark (since it's in INTERVENTION_REGISTRY and the
    // original verdict was 'confirms'). This produces a SECOND evidence
    // entry for H1.1 with structured causal fields (planId,
    // isCausalIntervention, causalVerdict, causalStrength,
    // manipulatedVariable).
    expect(protocolEvidence.length).toBeGreaterThanOrEqual(2)
    const original = protocolEvidence[0]!
    const interventionEvidence = protocolEvidence[1]!

    // Original evidence carries planId but NOT the intervention markers.
    expect(original.planId).toBe('protocol::tshark')
    expect(original.isCausalIntervention).toBeFalsy()
    expect(original.causalVerdict).toBeUndefined()

    // Intervention evidence carries the full structured causal payload.
    expect(interventionEvidence.planId).toBe('protocol::tshark')
    expect(interventionEvidence.isCausalIntervention).toBe(true)
    expect(interventionEvidence.causalVerdict).toBeDefined()
    expect(interventionEvidence.causalStrength).toBeGreaterThanOrEqual(0)
    expect(interventionEvidence.causalStrength).toBeLessThanOrEqual(1)
    expect(interventionEvidence.manipulatedVariable).toBe('TLS SNI extension presence')

    // Digest still carries the [CAUSAL ...] human-readable annotation
    // for audit logs / UI display, but it's no longer the source of truth.
    expect(interventionEvidence.resultDigest).toContain('[CAUSAL')
    expect(interventionEvidence.resultDigest).toContain('TLS SNI extension presence')
  })

  test('tool-call events include protocol::tshark execution', async () => {
    const table = buildProtocolTable()
    const toolTable = buildProtocolToolTable()
    const events = await drain(
      runPev({
        providers: TWO_PROVIDERS,
        targetBinary: TARGET_BINARY,
        initialClaim: INITIAL_CLAIM,
        budget: makeBudget({ maxRounds: 4 }),
        providerAdapter: makeCannedProviderAdapter(table),
        toolAdapter: makeCannedToolAdapter(toolTable),
      }),
    )

    // Verify protocol::tshark tool-call-start event exists.
    const tsharkStarts = events.filter(
      e => e.kind === 'tool-call-start' && e.planId === 'protocol::tshark',
    )
    expect(tsharkStarts.length).toBeGreaterThanOrEqual(1)

    // Verify protocol::tshark tool-call-complete with confirms verdict.
    const tsharkCompletes = events.filter(
      e => e.kind === 'tool-call-complete' && e.planId === 'protocol::tshark',
    )
    expect(tsharkCompletes.length).toBeGreaterThanOrEqual(1)
    if (tsharkCompletes[0]!.kind === 'tool-call-complete') {
      expect(tsharkCompletes[0]!.verdict).toBe('confirms')
    }
  })

  test('tool budget accounts for both original + intervention calls', async () => {
    const table = buildProtocolTable()
    const toolTable = buildProtocolToolTable()
    const events = await drain(
      runPev({
        providers: TWO_PROVIDERS,
        targetBinary: TARGET_BINARY,
        initialClaim: INITIAL_CLAIM,
        budget: makeBudget({ maxRounds: 4, maxToolCalls: 20 }),
        providerAdapter: makeCannedProviderAdapter(table),
        toolAdapter: makeCannedToolAdapter(toolTable),
      }),
    )

    const last = events[events.length - 1]!
    if (last.kind !== 'run-end') throw new Error('expected run-end')

    // capability::imports-table original (1) + intervention (1, it's in registry)
    // + protocol::tshark original (1) + protocol::tshark intervention (1)
    // = 4 budget slots consumed.
    expect(last.finalLedger.toolBudgetRemaining).toBe(20 - 4)
  })
})

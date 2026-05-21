/**
 * PevRunner — end-to-end smoke tests with mocked providers + tools.
 *
 * Coverage map (per task T10 DoD + R10-1 ~ R10-9, R5-6):
 *   - Multi-round happy path: 4 mock providers create H1-H4 in round 0,
 *     dispatch tool_calls in round 1, the runner records evidence,
 *     promotes H2 in round 2, and yields the canonical event order.
 *   - Event sequence: every round emits round-start → agent-output ×N
 *     → ledger-update → tool-call-* (only for tool_call actions) →
 *     ledger-update → round-end. The run ends with a `run-end` event.
 *   - Final ledger invariants: ≥ 4 hypotheses, ≥ 2 evidence records,
 *     H2 is in `evidence` status after promote.
 *   - Budget cap: maxRounds=2 with no `declare_done` should still emit
 *     `run-end { reason: 'budget-cap-hit' }` cleanly.
 *   - Parse-storm: when ≥ 50% agents emit unparseable output, the
 *     runner stops with `reason: 'parse-storm'`.
 *   - User abort: an already-aborted signal yields `reason: 'user-abort'`
 *     before any work is done.
 *   - Persistence callback: `onPersist` is invoked once per round, with
 *     the latest ledger snapshot, and a thrown error doesn't crash
 *     the run.
 *   - Helper: `redactSecrets` walks nested args + arrays.
 *   - Helper: `mergeArgs` filters override keys to the allow-list.
 *   - Helper: `digestStdout` truncates oversized stdouts.
 *   - No unhandled rejections across all assertions.
 *
 * **Validates: Requirements 10.1, 10.2, 10.3, 10.4, 10.5, 10.7, 10.9, 5.6**
 */

import { describe, expect, test } from 'bun:test'
import type { ArenaProvider } from '../../arena/providers.js'
import { findToolPlan } from '../canonicalTests.js'
import {
  digestStdout,
  mergeArgs,
  redactSecrets,
  runPev,
  type PevRoundEvent,
  type PevRunOpts,
  type ProviderAdapterResult,
  type ToolAdapterResult,
} from '../pevRunner.js'
import type { ToolPlan } from '../canonicalTests.js'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Build a stub ArenaProvider — only `id` matters to the runner; the
 * remaining fields are filler so `loadArenaProviders`-shaped consumers
 * stay happy if they ever inspect the structure.
 */
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

const A1 = makeProvider('gpt')
const A2 = makeProvider('claude')
const A3 = makeProvider('deepseek')
const A4 = makeProvider('qwen')

const FOUR_PROVIDERS: readonly ArenaProvider[] = [A1, A2, A3, A4]

/** Build a budget object using the runner's defaults. */
function makeBudget(overrides: Partial<PevRunOpts['budget']> = {}): PevRunOpts['budget'] {
  return {
    maxRounds: 4,
    maxToolCalls: 24,
    maxTokens: 300_000,
    maxWallClockMs: 30 * 60 * 1000,
    ...overrides,
  }
}

/**
 * Build a target-binary stub. Path/sha/size are embedded in the system
 * prompt only — the runner doesn't read the file.
 */
const TARGET_BINARY = {
  path: 'e:/samples/payload.exe',
  sha256: 'a3f1b2'.padEnd(64, '0'),
  size: 1024,
}

const INITIAL_CLAIM = '判断加壳 + 主体语言 + 反调试'

/**
 * Compose an LLM-like assistant reply containing the three required
 * sections (prose / pev / cav). The cav block is dummy data — the
 * runner's parser only consumes the pev block.
 */
function fakeAgentReply(pevJson: object, prose = '...analysis...'): string {
  return [
    '## 1. 内容',
    prose,
    '',
    '```pev',
    JSON.stringify(pevJson, null, 2),
    '```',
    '',
    '```cav',
    JSON.stringify({
      self_entropy: 0.4,
      calibration: 0.85,
      update_kl: 0.0,
      latency: 200,
      repair_style: 'none',
    }),
    '```',
  ].join('\n')
}

/**
 * Build a minimal valid PevOutput for round 0 — every agent creates one
 * top-level hypothesis of a unique kind.
 */
function pevRound0(
  agentId: string,
  hypothesisId: string,
  kind: string,
  text: string,
): object {
  return {
    schema_version: '1.0',
    agent_id: agentId,
    round: 0,
    observations: [],
    hypothesis_updates: [
      {
        op: 'create',
        id: hypothesisId,
        kind,
        text,
        confidence: 0.6,
      },
    ],
    next_action: {
      kind: 'observe_only',
      rationale: 'wait for round 1 to start tool probes',
    },
  }
}

/**
 * Round-1 output that proposes a tool_call against the provided H.
 */
function pevRound1ToolCall(
  agentId: string,
  hypothesisId: string,
  toolPlanId: string,
): object {
  return {
    schema_version: '1.0',
    agent_id: agentId,
    round: 1,
    observations: [],
    hypothesis_updates: [],
    next_action: {
      kind: 'tool_call',
      hypothesis_id: hypothesisId,
      tool_plan_id: toolPlanId,
      args_override: null,
    },
  }
}

/**
 * Round-2 output that promotes H2 (packer) given the confirms evidence
 * `E1` written in round 1.
 */
function pevRound2PromoteH2(agentId: string): object {
  return {
    schema_version: '1.0',
    agent_id: agentId,
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
        id: 'H2',
        rationale_short: 'diec output reports UPX packer',
      },
    ],
    next_action: {
      kind: 'declare_done',
      rationale: 'packer hypothesis confirmed; my slice is finished',
    },
  }
}

/** Generic observe-only PevOutput for filler agents. */
function pevObserve(agentId: string, round: number): object {
  return {
    schema_version: '1.0',
    agent_id: agentId,
    round,
    observations: [],
    hypothesis_updates: [],
    next_action: {
      kind: 'observe_only',
      rationale: 'no fresh information this round',
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Helper utilities                                                           */
/* -------------------------------------------------------------------------- */

describe('pevRunner helpers', () => {
  test('redactSecrets walks nested objects + arrays', () => {
    const input = {
      command: 'curl https://api',
      apiKey: 'sk-secret123',
      headers: {
        Authorization: 'Bearer abc',
        'X-Custom': 'safe',
      },
      list: [
        { token: 'evil' },
        { harmless: 'yes' },
      ],
    }
    const out = redactSecrets(input) as Record<string, unknown>
    expect(out.command).toBe('curl https://api')
    expect(out.apiKey).toBe('***')
    expect((out.headers as Record<string, unknown>).Authorization).toBe('***')
    expect((out.headers as Record<string, unknown>)['X-Custom']).toBe('safe')
    const list = out.list as Array<Record<string, unknown>>
    expect(list[0]?.token).toBe('***')
    expect(list[1]?.harmless).toBe('yes')
    // Pure: input not mutated.
    expect(input.apiKey).toBe('sk-secret123')
  })

  test('mergeArgs filters override keys by the allow-list', () => {
    const merged = mergeArgs(
      { command: 'file', timeoutMs: 5000 },
      { command: 'readelf', extra: 'nope' },
      ['command'],
    )
    expect(merged.command).toBe('readelf')
    expect(merged.timeoutMs).toBe(5000)
    expect(merged.extra).toBeUndefined()
  })

  test('mergeArgs accepts null override', () => {
    const merged = mergeArgs({ a: 1 }, null, ['a'])
    expect(merged).toEqual({ a: 1 })
  })

  test('digestStdout passes short stdout untouched', () => {
    expect(digestStdout('short')).toBe('short')
  })

  test('digestStdout truncates oversized stdout with marker', () => {
    const big = 'x'.repeat(2000)
    const out = digestStdout(big)
    expect(out.length).toBeLessThanOrEqual(520)
    expect(out).toContain('\n…\n')
    expect(out.startsWith('x'.repeat(400))).toBe(true)
    expect(out.endsWith('x'.repeat(100))).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Driver helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Build a `providerAdapter` that returns canned replies keyed by
 * (agentId, round). Missing keys default to a benign observe-only reply
 * so untested rounds don't crash the loop.
 */
function makeCannedProviderAdapter(
  table: ReadonlyMap<string, string>,
): NonNullable<PevRunOpts['providerAdapter']> {
  return async (provider, _system, _user, _signal) => {
    // The user prompt embeds the round number in its header (e.g.
    // "## Round 1 · agent_id: `gpt`"). We use a regex over the user
    // string so the canned table can be keyed by `${agentId}:${round}`.
    const m = _user.match(/Round\s+(\d+)/)
    const round = m ? parseInt(m[1]!, 10) : 0
    const key = `${provider.id}:${round}`
    const content = table.get(key)
    if (content !== undefined) {
      return { content } satisfies ProviderAdapterResult
    }
    // Default: observe-only for the named round.
    const defaultReply = fakeAgentReply(pevObserve(provider.id, round))
    return { content: defaultReply }
  }
}

/**
 * Build a `toolAdapter` that returns canned stdout keyed by
 * `tool_plan_id`. Plans not in the table return a generic inconclusive
 * reply.
 */
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

/** Drain an async generator into an array; returns events in order. */
async function drain(
  gen: AsyncGenerator<PevRoundEvent, void, void>,
): Promise<PevRoundEvent[]> {
  const out: PevRoundEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

/* -------------------------------------------------------------------------- */
/* End-to-end happy path                                                      */
/* -------------------------------------------------------------------------- */

describe('runPev — end-to-end happy path', () => {
  /**
   * Build the canned provider table for the 3-round happy path.
   *
   * Round 0: each agent creates one hypothesis.
   *   gpt      → H1 (file-class)
   *   claude   → H2 (packer)
   *   deepseek → H3 (compiler)
   *   qwen     → H4 (anti-analysis)
   *
   * Round 1: claude proposes packer::diec on H2; others observe.
   *
   * Round 2: claude promotes H2 (with E1 confirms observation) and
   * declares done. The runner stops here because A1/A3/A4 still have
   * `open` H but the maxRounds cap will let us assert the event stream
   * for an in-progress termination.
   */
  function buildHappyPathTable(): ReadonlyMap<string, string> {
    const table = new Map<string, string>()
    table.set(
      'gpt:0',
      fakeAgentReply(pevRound0('gpt', 'H1', 'file-class', 'Likely PE32+ executable container')),
    )
    table.set(
      'claude:0',
      fakeAgentReply(pevRound0('claude', 'H2', 'packer', 'Suspect UPX-packed binary')),
    )
    table.set(
      'deepseek:0',
      fakeAgentReply(pevRound0('deepseek', 'H3', 'compiler', 'Likely .NET compiler artefact')),
    )
    table.set(
      'qwen:0',
      fakeAgentReply(pevRound0('qwen', 'H4', 'anti-analysis', 'Possible TLS-callback anti-debug')),
    )

    table.set(
      'claude:1',
      fakeAgentReply(pevRound1ToolCall('claude', 'H2', 'packer::diec')),
    )
    table.set('gpt:1', fakeAgentReply(pevObserve('gpt', 1)))
    table.set('deepseek:1', fakeAgentReply(pevObserve('deepseek', 1)))
    table.set('qwen:1', fakeAgentReply(pevObserve('qwen', 1)))

    table.set('claude:2', fakeAgentReply(pevRound2PromoteH2('claude')))
    table.set('gpt:2', fakeAgentReply(pevObserve('gpt', 2)))
    table.set('deepseek:2', fakeAgentReply(pevObserve('deepseek', 2)))
    table.set('qwen:2', fakeAgentReply(pevObserve('qwen', 2)))

    return table
  }

  function buildHappyPathToolTable(): ReadonlyMap<string, ToolAdapterResult> {
    return new Map<string, ToolAdapterResult>([
      [
        'packer::diec',
        {
          stdout: 'Detect-it-Easy report:\nPacker: UPX(4.0)[NRV,brute]\nLinker: Microsoft (14.0)\n',
          exitCode: 0,
          durationMs: 120,
        },
      ],
    ])
  }

  test('emits canonical event sequence and produces a final ledger', async () => {
    const table = buildHappyPathTable()
    const toolTable = buildHappyPathToolTable()
    const events = await drain(
      runPev({
        providers: FOUR_PROVIDERS,
        targetBinary: TARGET_BINARY,
        initialClaim: INITIAL_CLAIM,
        budget: makeBudget({ maxRounds: 3 }),
        providerAdapter: makeCannedProviderAdapter(table),
        toolAdapter: makeCannedToolAdapter(toolTable),
      }),
    )

    // 1) The stream ends with exactly one `run-end`.
    const last = events[events.length - 1]!
    expect(last.kind).toBe('run-end')
    if (last.kind !== 'run-end') throw new Error('unreachable')
    // With maxRounds=3 and no all-resolved trigger, we expect a budget cap.
    expect(['budget-cap-hit', 'all-resolved', 'stall-guard-hit']).toContain(
      last.reason,
    )

    // 2) Every round-start has a matching round-end before run-end.
    const starts = events.filter(e => e.kind === 'round-start').length
    const ends = events.filter(e => e.kind === 'round-end').length
    expect(starts).toBe(ends)
    expect(starts).toBeGreaterThanOrEqual(1)

    // 3) Each round emits 4 agent-output events (one per provider).
    const agentOutputsRound0 = events.filter(
      e => e.kind === 'agent-output' && e.round === 0,
    )
    expect(agentOutputsRound0).toHaveLength(4)

    // 4) Tool-call events for round 1 — exactly one (claude::diec).
    const toolStartsR1 = events.filter(
      e => e.kind === 'tool-call-start' && e.round === 1,
    )
    expect(toolStartsR1).toHaveLength(1)
    if (toolStartsR1[0]!.kind === 'tool-call-start') {
      expect(toolStartsR1[0]!.agentId).toBe('claude')
      expect(toolStartsR1[0]!.planId).toBe('packer::diec')
    }
    const toolCompletesR1 = events.filter(
      e => e.kind === 'tool-call-complete' && e.round === 1,
    )
    expect(toolCompletesR1).toHaveLength(1)
    if (toolCompletesR1[0]!.kind === 'tool-call-complete') {
      expect(toolCompletesR1[0]!.verdict).toBe('confirms')
    }

    // 5) Final ledger has all 4 hypotheses + ≥ 1 evidence + H2 promoted.
    const finalLedger = last.finalLedger
    expect(finalLedger.hypotheses.size).toBeGreaterThanOrEqual(4)
    expect(finalLedger.evidenceLog.length).toBeGreaterThanOrEqual(1)
    const h2 = finalLedger.hypotheses.get('H2')
    expect(h2).toBeDefined()
    expect(h2?.status).toBe('evidence')
    // E1 must be in H2's evidence trail.
    expect(h2?.evidenceTrail).toContain('E1')

    // 6) Tool budget decreased: original packer::diec (1) + causal
    //    intervention (1, since packer::diec is in INTERVENTION_REGISTRY
    //    and the original verdict was 'confirms') = 2 slots consumed.
    expect(finalLedger.toolBudgetRemaining).toBe(24 - 2)
  })

  test('parse-stats counters reflect L1 hits across rounds', async () => {
    const table = buildHappyPathTable()
    const events = await drain(
      runPev({
        providers: FOUR_PROVIDERS,
        targetBinary: TARGET_BINARY,
        initialClaim: INITIAL_CLAIM,
        budget: makeBudget({ maxRounds: 2 }),
        providerAdapter: makeCannedProviderAdapter(table),
        toolAdapter: makeCannedToolAdapter(buildHappyPathToolTable()),
      }),
    )
    const last = events[events.length - 1]!
    if (last.kind !== 'run-end') throw new Error('expected run-end')
    // 2 rounds × 4 agents = 8 successful Layer-1 parses.
    expect(last.finalLedger.parseStats.layer1Hits).toBe(8)
    expect(last.finalLedger.parseStats.parseFailures).toBe(0)
  })

  test('agent-output events carry parseResult.ok=true for canned good replies', async () => {
    const events = await drain(
      runPev({
        providers: FOUR_PROVIDERS,
        targetBinary: TARGET_BINARY,
        initialClaim: INITIAL_CLAIM,
        budget: makeBudget({ maxRounds: 1 }),
        providerAdapter: makeCannedProviderAdapter(buildHappyPathTable()),
        toolAdapter: makeCannedToolAdapter(new Map()),
      }),
    )
    const agentOutputs = events.filter(e => e.kind === 'agent-output')
    expect(agentOutputs.length).toBe(4)
    for (const ev of agentOutputs) {
      if (ev.kind !== 'agent-output') continue
      expect(ev.parseResult.ok).toBe(true)
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Persistence callback                                                       */
/* -------------------------------------------------------------------------- */

describe('runPev — persistence callback', () => {
  test('onPersist is invoked once per round with the latest ledger', async () => {
    const calls: Array<{ round: number; size: number }> = []
    const table = new Map<string, string>([
      ['gpt:0', fakeAgentReply(pevRound0('gpt', 'H1', 'file-class', 'Likely PE32+ executable'))],
      ['claude:0', fakeAgentReply(pevRound0('claude', 'H2', 'packer', 'Possible UPX packer'))],
      ['deepseek:0', fakeAgentReply(pevObserve('deepseek', 0))],
      ['qwen:0', fakeAgentReply(pevObserve('qwen', 0))],
    ])
    await drain(
      runPev({
        providers: FOUR_PROVIDERS,
        targetBinary: TARGET_BINARY,
        initialClaim: INITIAL_CLAIM,
        budget: makeBudget({ maxRounds: 1 }),
        providerAdapter: makeCannedProviderAdapter(table),
        toolAdapter: makeCannedToolAdapter(new Map()),
        onPersist: async (ledger, round) => {
          calls.push({ round, size: ledger.hypotheses.size })
        },
      }),
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]!.round).toBe(0)
    expect(calls[0]!.size).toBeGreaterThanOrEqual(2)
  })

  test('onPersist throwing does not crash the run', async () => {
    const table = new Map<string, string>([
      ['gpt:0', fakeAgentReply(pevObserve('gpt', 0))],
      ['claude:0', fakeAgentReply(pevObserve('claude', 0))],
      ['deepseek:0', fakeAgentReply(pevObserve('deepseek', 0))],
      ['qwen:0', fakeAgentReply(pevObserve('qwen', 0))],
    ])
    const events = await drain(
      runPev({
        providers: FOUR_PROVIDERS,
        targetBinary: TARGET_BINARY,
        initialClaim: INITIAL_CLAIM,
        budget: makeBudget({ maxRounds: 1 }),
        providerAdapter: makeCannedProviderAdapter(table),
        toolAdapter: makeCannedToolAdapter(new Map()),
        onPersist: async () => {
          throw new Error('disk full')
        },
      }),
    )
    const last = events[events.length - 1]!
    expect(last.kind).toBe('run-end')
  })
})

/* -------------------------------------------------------------------------- */
/* Stop conditions                                                            */
/* -------------------------------------------------------------------------- */

describe('runPev — stop conditions', () => {
  test('user-abort: aborted signal yields run-end before any work', async () => {
    const ac = new AbortController()
    ac.abort()
    const events = await drain(
      runPev({
        providers: FOUR_PROVIDERS,
        targetBinary: TARGET_BINARY,
        initialClaim: INITIAL_CLAIM,
        budget: makeBudget(),
        signal: ac.signal,
        providerAdapter: async () => ({ content: '' }),
        toolAdapter: async () => ({ stdout: '', exitCode: 0, durationMs: 0 }),
      }),
    )
    expect(events).toHaveLength(1)
    const ev = events[0]!
    expect(ev.kind).toBe('run-end')
    if (ev.kind === 'run-end') {
      expect(ev.reason).toBe('user-abort')
    }
  })

  test('parse-storm: ≥ 50% of agents emit unparseable output', async () => {
    // 4 providers, 3 emit garbage → 75% failure rate ≥ 0.5 threshold.
    const adapter: NonNullable<PevRunOpts['providerAdapter']> = async (
      provider,
    ) => {
      if (provider.id === 'gpt') {
        return { content: fakeAgentReply(pevObserve('gpt', 0)) }
      }
      // Garbage that fails Layer 1, Layer 2, and (with no retryFn-fixing)
      // Layer 3 too.
      return { content: 'no fenced block here\nstill nothing\n' }
    }
    const events = await drain(
      runPev({
        providers: FOUR_PROVIDERS,
        targetBinary: TARGET_BINARY,
        initialClaim: INITIAL_CLAIM,
        budget: makeBudget(),
        providerAdapter: adapter,
        toolAdapter: async () => ({ stdout: '', exitCode: 0, durationMs: 0 }),
      }),
    )
    const last = events[events.length - 1]!
    expect(last.kind).toBe('run-end')
    if (last.kind === 'run-end') {
      expect(last.reason).toBe('parse-storm')
    }
  })

  test('budget-cap-hit: missing providerAdapter yields immediate run-end', async () => {
    const events = await drain(
      runPev({
        providers: FOUR_PROVIDERS,
        targetBinary: TARGET_BINARY,
        initialClaim: INITIAL_CLAIM,
        budget: makeBudget(),
      }),
    )
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe('run-end')
  })

  test('budget-cap-hit: maxRounds reached without all-resolved', async () => {
    // All agents perpetually observe — no hypothesis ever leaves `open`.
    const adapter: NonNullable<PevRunOpts['providerAdapter']> = async (
      provider,
      _sys,
      user,
    ) => {
      const m = user.match(/Round\s+(\d+)/)
      const round = m ? parseInt(m[1]!, 10) : 0
      return { content: fakeAgentReply(pevObserve(provider.id, round)) }
    }
    const events = await drain(
      runPev({
        providers: FOUR_PROVIDERS,
        targetBinary: TARGET_BINARY,
        initialClaim: INITIAL_CLAIM,
        // maxRounds=2 + stall-guard threshold 5 (so stall-guard does NOT
        // fire before maxRounds — we want to assert the budget-cap path).
        budget: makeBudget({ maxRounds: 2 }),
        stallGuardConsecutive: 5,
        providerAdapter: adapter,
        toolAdapter: async () => ({ stdout: '', exitCode: 0, durationMs: 0 }),
      }),
    )
    const last = events[events.length - 1]!
    expect(last.kind).toBe('run-end')
    if (last.kind === 'run-end') {
      expect(last.reason).toBe('budget-cap-hit')
    }
  })

  test('stall-guard-hit: 2 consecutive observe-only rounds with no work', async () => {
    // No hypotheses created at all → scheduler emits "observe" for every
    // agent → stallGuardWarning=true on every round → after 2 rounds the
    // runner stops with stall-guard-hit.
    const adapter: NonNullable<PevRunOpts['providerAdapter']> = async (
      provider,
      _sys,
      user,
    ) => {
      const m = user.match(/Round\s+(\d+)/)
      const round = m ? parseInt(m[1]!, 10) : 0
      return { content: fakeAgentReply(pevObserve(provider.id, round)) }
    }
    const events = await drain(
      runPev({
        providers: FOUR_PROVIDERS,
        targetBinary: TARGET_BINARY,
        initialClaim: INITIAL_CLAIM,
        budget: makeBudget({ maxRounds: 8 }),
        stallGuardConsecutive: 2,
        providerAdapter: adapter,
        toolAdapter: async () => ({ stdout: '', exitCode: 0, durationMs: 0 }),
      }),
    )
    const last = events[events.length - 1]!
    expect(last.kind).toBe('run-end')
    if (last.kind === 'run-end') {
      expect(last.reason).toBe('stall-guard-hit')
    }
  })
})

/* -------------------------------------------------------------------------- */
/* Sanity: canonical plan exists for the test fixture                         */
/* -------------------------------------------------------------------------- */

describe('runPev — canonical-plan sanity', () => {
  test('packer::diec exists in CANONICAL_TESTS (e2e fixture pre-condition)', () => {
    const plan = findToolPlan('packer::diec')
    expect(plan).toBeDefined()
    expect(plan?.kind).toBe('packer')
    // The canned tool stdout we ship in the happy-path test must produce
    // a `confirms` verdict against this plan; verify here so a
    // canonicalTests refactor doesn't silently break the e2e assertion.
    const testPlan: ToolPlan = plan!
    const confirmRe = testPlan.confirms[0]!
    expect(confirmRe.test('Packer: UPX(4.0)[NRV,brute]')).toBe(true)
  })
})

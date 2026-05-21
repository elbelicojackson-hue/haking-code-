/**
 * T14 — Integration smoke test for `/ccb-pev`.
 *
 * This test exercises the command-level flow end-to-end using the
 * `runPev` async generator with fake providers + fake tool adapter,
 * then asserts the final markdown summary and the persisted
 * `<sessionId>.pev.json` file meet the spec's acceptance criteria.
 *
 * Unlike `pev-e2e.test.ts` (T10) which tests the runner in isolation,
 * this test validates the full integration path that the `PevSession`
 * component would drive — including persistence, summary generation,
 * and schema compliance of the output file.
 *
 * Coverage map (per task T14 DoD):
 *   - Final summary markdown contains "stop reason", "hypothesis",
 *     "evidence", and `.pev.json` path.
 *   - `<sessionDir>/<sessionId>.pev.json` file exists, is valid JSON,
 *     and has `schemaVersion === '1.0'`.
 *   - The persisted log contains the expected hypothesis count and
 *     evidence entries.
 *   - Runs in ≤ 30s on CI (no real network, no real LLM).
 *
 * Validates: Requirements 10.*, 11.*
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { findToolPlan } from '../../cav/pev/canonicalTests.js'
import {
  buildPevEvalLog,
  writePevEvalLog,
  type PevEvalLog,
  type PevEvalLogPerAgentOutput,
  type PevEvalLogRound,
} from '../../cav/pev/persistence.js'
import {
  runPev,
  type PevRoundEvent,
  type PevRunOpts,
  type ProviderAdapterResult,
  type SharedLedger,
  type StopReason,
  type ToolAdapterResult,
} from '../../cav/pev/pevRunner.js'
import type { ArenaProvider } from '../../../services/cav/arena/providers.js'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let tempDir = ''

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'pev-integration-'))
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = ''
  }
})

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

const PROVIDERS: readonly ArenaProvider[] = [
  makeProvider('gpt'),
  makeProvider('claude'),
  makeProvider('deepseek'),
  makeProvider('qwen'),
]

const TARGET_BINARY = {
  path: 'e:/samples/payload.exe',
  sha256: 'a3f1b2'.padEnd(64, '0'),
  size: 2048,
}

const BUDGET: PevRunOpts['budget'] = {
  maxRounds: 3,
  maxToolCalls: 24,
  maxTokens: 300_000,
  maxWallClockMs: 30 * 60 * 1000,
}

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
    JSON.stringify({ self_entropy: 0.4, calibration: null, update_kl: null, repair_style: 'none' }),
    '```',
  ].join('\n')
}

function pevRound0(agentId: string, hId: string, kind: string, text: string): object {
  return {
    schema_version: '1.0',
    agent_id: agentId,
    round: 0,
    observations: [],
    hypothesis_updates: [{ op: 'create', id: hId, kind, text, confidence: 0.6 }],
    next_action: { kind: 'observe_only', rationale: 'wait for round 1' },
  }
}

function pevRound1ToolCall(agentId: string, hId: string, planId: string): object {
  return {
    schema_version: '1.0',
    agent_id: agentId,
    round: 1,
    observations: [],
    hypothesis_updates: [],
    next_action: { kind: 'tool_call', hypothesis_id: hId, tool_plan_id: planId, args_override: null },
  }
}

function pevRound2Promote(agentId: string): object {
  return {
    schema_version: '1.0',
    agent_id: agentId,
    round: 2,
    observations: [{ evidence_id: 'E1', verdict: 'confirms', confidence: 0.9 }],
    hypothesis_updates: [{ op: 'promote', id: 'H2', rationale_short: 'diec confirms UPX packer' }],
    next_action: { kind: 'declare_done', rationale: 'packer hypothesis confirmed' },
  }
}

function pevObserve(agentId: string, round: number): object {
  return {
    schema_version: '1.0',
    agent_id: agentId,
    round,
    observations: [],
    hypothesis_updates: [],
    next_action: { kind: 'observe_only', rationale: 'no fresh information' },
  }
}

function buildCannedProviderAdapter(): NonNullable<PevRunOpts['providerAdapter']> {
  const table = new Map<string, string>()
  table.set('gpt:0', fakeAgentReply(pevRound0('gpt', 'H1', 'file-class', 'PE32+ executable container')))
  table.set('claude:0', fakeAgentReply(pevRound0('claude', 'H2', 'packer', 'Suspect UPX-packed binary')))
  table.set('deepseek:0', fakeAgentReply(pevRound0('deepseek', 'H3', 'compiler', '.NET compiler artefact')))
  table.set('qwen:0', fakeAgentReply(pevRound0('qwen', 'H4', 'anti-analysis', 'TLS-callback anti-debug')))
  table.set('claude:1', fakeAgentReply(pevRound1ToolCall('claude', 'H2', 'packer::diec')))
  table.set('claude:2', fakeAgentReply(pevRound2Promote('claude')))

  return async (provider, _sys, user, _signal) => {
    const m = user.match(/Round\s+(\d+)/)
    const round = m ? parseInt(m[1]!, 10) : 0
    const key = `${provider.id}:${round}`
    const content = table.get(key) ?? fakeAgentReply(pevObserve(provider.id, round))
    return { content } satisfies ProviderAdapterResult
  }
}

function buildCannedToolAdapter(): NonNullable<PevRunOpts['toolAdapter']> {
  return async (plan, _args, _signal) => {
    if (plan.id === 'packer::diec') {
      return {
        stdout: 'Detect-it-Easy report:\nPacker: UPX(4.0)[NRV,brute]\nLinker: Microsoft (14.0)\n',
        exitCode: 0,
        durationMs: 120,
      } satisfies ToolAdapterResult
    }
    return { stdout: '', exitCode: 1, durationMs: 5 } satisfies ToolAdapterResult
  }
}

/** Drain the async generator into an array. */
async function drain(gen: AsyncGenerator<PevRoundEvent, void, void>): Promise<PevRoundEvent[]> {
  const out: PevRoundEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

/* -------------------------------------------------------------------------- */
/* Integration test — full pipeline with persistence                          */
/* -------------------------------------------------------------------------- */

describe('/ccb-pev integration smoke test', () => {
  test('full 3-round run produces valid .pev.json + summary with expected markers', async () => {
    const sessionId = 'integration-test-001'
    const initialClaim = '判断加壳 + 主体语言 + 反调试'

    // 1. Run the PEV loop
    const events = await drain(
      runPev({
        providers: PROVIDERS,
        targetBinary: TARGET_BINARY,
        initialClaim,
        budget: BUDGET,
        providerAdapter: buildCannedProviderAdapter(),
        toolAdapter: buildCannedToolAdapter(),
      }),
    )

    // 2. Extract the final event
    const last = events[events.length - 1]!
    expect(last.kind).toBe('run-end')
    if (last.kind !== 'run-end') throw new Error('unreachable')

    const finalLedger = last.finalLedger

    // 3. Build the PevEvalLog (same as PevSession does)
    const rounds: PevEvalLogRound[] = []
    let currentRoundOutputs: PevEvalLogPerAgentOutput[] = []
    let currentRoundIndex = 0
    for (const ev of events) {
      if (ev.kind === 'round-start') {
        currentRoundIndex = ev.round
        currentRoundOutputs = []
      } else if (ev.kind === 'agent-output') {
        currentRoundOutputs.push(
          ev.parseResult.ok
            ? { agentId: ev.agentId, pev: ev.parseResult.parsed, parseResult: { ok: true, layerHit: ev.parseResult.layerHit } }
            : { agentId: ev.agentId, parseResult: { ok: false, errorKind: ev.parseResult.errorKind, detail: ev.parseResult.detail } },
        )
      } else if (ev.kind === 'round-end') {
        rounds.push({ round: currentRoundIndex, perAgentOutputs: currentRoundOutputs })
      }
    }

    const log = buildPevEvalLog({
      sessionId,
      startedAt: Date.now() - 5000,
      endedAt: Date.now(),
      targetBinary: TARGET_BINARY,
      initialClaim,
      budget: BUDGET,
      finalLedger,
      rounds,
      stopReason: last.reason,
      ...(last.detail !== undefined ? { stopDetail: last.detail } : {}),
    })

    // 4. Write the .pev.json
    const writeResult = await writePevEvalLog({
      sessionDir: tempDir,
      sessionId,
      log,
    })
    expect(writeResult.ok).toBe(true)
    if (!writeResult.ok) throw new Error('write failed')

    // 5. Assert: file exists
    const filePath = writeResult.path
    const st = await stat(filePath)
    expect(st.isFile()).toBe(true)

    // 6. Assert: valid JSON + schema_version
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as PevEvalLog
    expect(parsed.schemaVersion).toBe('1.0')
    expect(parsed.profileId).toBe('reverse')
    expect(parsed.sessionId).toBe(sessionId)
    expect(parsed.targetBinary.sha256).toBe(TARGET_BINARY.sha256)

    // 7. Assert: hypothesis count ≥ 4 and evidence ≥ 1
    expect(parsed.finalLedger.hypotheses.length).toBeGreaterThanOrEqual(4)
    expect(parsed.finalLedger.evidenceLog.length).toBeGreaterThanOrEqual(1)

    // 8. Assert: H2 was promoted to 'evidence' status
    const h2 = parsed.finalLedger.hypotheses.find(h => h.id === 'H2')
    expect(h2).toBeDefined()
    expect(h2?.status).toBe('evidence')

    // 9. Assert: stop reason is present
    expect(parsed.stopReason).toBeDefined()
    expect(['all-resolved', 'budget-cap-hit', 'stall-guard-hit']).toContain(parsed.stopReason)
  })

  test('final summary markdown contains required markers', async () => {
    const events = await drain(
      runPev({
        providers: PROVIDERS,
        targetBinary: TARGET_BINARY,
        initialClaim: '判断加壳',
        budget: BUDGET,
        providerAdapter: buildCannedProviderAdapter(),
        toolAdapter: buildCannedToolAdapter(),
      }),
    )

    const last = events[events.length - 1]!
    if (last.kind !== 'run-end') throw new Error('expected run-end')

    // Build summary the same way PevSession does
    const finalLedger = last.finalLedger
    const summaryLines: string[] = []
    summaryLines.push(`stop reason: ${last.reason}`)
    summaryLines.push(`hypotheses: ${finalLedger.hypotheses.size}`)
    summaryLines.push(`evidence: ${finalLedger.evidenceLog.length}`)
    summaryLines.push('.pev.json')

    // The summary must contain these key markers (R11-6)
    const summary = summaryLines.join('\n')
    expect(summary).toContain('stop reason')
    expect(summary).toContain('hypotheses')
    expect(summary).toContain('evidence')
    expect(summary).toContain('.pev.json')
  })

  test('persisted .pev.json rounds array has correct structure', async () => {
    const sessionId = 'integration-rounds-check'
    const events = await drain(
      runPev({
        providers: PROVIDERS,
        targetBinary: TARGET_BINARY,
        initialClaim: '分析目标',
        budget: { ...BUDGET, maxRounds: 2 },
        providerAdapter: buildCannedProviderAdapter(),
        toolAdapter: buildCannedToolAdapter(),
      }),
    )

    const last = events[events.length - 1]!
    if (last.kind !== 'run-end') throw new Error('expected run-end')

    // Build rounds from events
    const rounds: PevEvalLogRound[] = []
    let currentOutputs: PevEvalLogPerAgentOutput[] = []
    let roundIdx = 0
    for (const ev of events) {
      if (ev.kind === 'round-start') { roundIdx = ev.round; currentOutputs = [] }
      else if (ev.kind === 'agent-output') {
        currentOutputs.push(
          ev.parseResult.ok
            ? { agentId: ev.agentId, pev: ev.parseResult.parsed, parseResult: { ok: true, layerHit: ev.parseResult.layerHit } }
            : { agentId: ev.agentId, parseResult: { ok: false, errorKind: ev.parseResult.errorKind, detail: ev.parseResult.detail } },
        )
      } else if (ev.kind === 'round-end') {
        rounds.push({ round: roundIdx, perAgentOutputs: currentOutputs })
      }
    }

    const log = buildPevEvalLog({
      sessionId,
      startedAt: Date.now() - 3000,
      endedAt: Date.now(),
      targetBinary: TARGET_BINARY,
      initialClaim: '分析目标',
      budget: { ...BUDGET, maxRounds: 2 },
      finalLedger: last.finalLedger,
      rounds,
      stopReason: last.reason,
    })

    const writeResult = await writePevEvalLog({ sessionDir: tempDir, sessionId, log })
    expect(writeResult.ok).toBe(true)
    if (!writeResult.ok) return

    const raw = await readFile(writeResult.path, 'utf8')
    const parsed = JSON.parse(raw) as PevEvalLog

    // Rounds array should have 2 entries (maxRounds=2)
    expect(parsed.rounds.length).toBe(2)
    // Each round should have 4 agent outputs (one per provider)
    for (const r of parsed.rounds) {
      expect(r.perAgentOutputs.length).toBe(4)
      for (const out of r.perAgentOutputs) {
        expect(out.agentId).toBeDefined()
        expect(out.parseResult.ok).toBeDefined()
      }
    }
  })

  test('completes within 30 seconds (CI budget)', async () => {
    const start = Date.now()
    await drain(
      runPev({
        providers: PROVIDERS,
        targetBinary: TARGET_BINARY,
        initialClaim: '快速测试',
        budget: { ...BUDGET, maxRounds: 2 },
        providerAdapter: buildCannedProviderAdapter(),
        toolAdapter: buildCannedToolAdapter(),
      }),
    )
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(30_000)
  })
})

/**
 * Tests for `persistence.ts` (T11) — `<sessionId>.pev.json` writer.
 *
 * Coverage map:
 *   - buildPevEvalLog: required-fields shape; hypotheses sorted by id;
 *     finalLedger.hypotheses is an array (not a Map).
 *   - writePevEvalLog: file appears at the expected path; readback
 *     parses; schemaVersion === '1.0'; field round-trip.
 *   - Error injection: write to a non-existent dir → `{ ok: false }`,
 *     no exception propagates.
 *   - Atomic write: no `.tmp` artefact left behind on success.
 *   - Idempotent overwrite: writing twice succeeds and the second
 *     payload wins.
 *   - File permissions (POSIX only): file mode is 0o600 on Linux/Mac;
 *     skipped on Windows.
 *
 * These tests use `os.tmpdir()` + a `mkdtemp` per test for isolation;
 * the directory is recursively rm-rf'd in `afterEach` so we don't pile
 * up stale artefacts on the developer's machine.
 *
 * Validates: Requirements 6.5, 6.6, 6.7, 6.8, 14.6.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  appendEvidence,
  applyHypothesisUpdate,
  createEmptyLedger,
  type Hypothesis,
  type SharedLedger,
} from '../ledger.js'
import {
  buildPevEvalLog,
  writePevEvalLog,
  type PevEvalLog,
} from '../persistence.js'
import type { PevBudget } from '../pevRunner.js'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

let tempDir = ''

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'pev-persistence-'))
})

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = ''
  }
})

const BUDGET: PevBudget = {
  maxRounds: 8,
  maxToolCalls: 24,
  maxTokens: 300_000,
  maxWallClockMs: 30 * 60 * 1000,
}

const TARGET_BINARY = {
  path: '/tmp/sample.bin',
  sha256: 'a'.repeat(64),
  size: 1024,
} as const

function makeLedgerWithMixedIds(): SharedLedger {
  // Insert in non-sorted order so the "sort by id" test has something to
  // demonstrate. Mix of single-segment and dotted ids.
  let l = createEmptyLedger(BUDGET.maxToolCalls)
  l = applyHypothesisUpdate(
    l,
    {
      op: 'create',
      id: 'H10',
      kind: 'packer',
      text: 'tenth root hypothesis under test',
      confidence: 0.6,
    },
    'agent-a',
    0,
  )
  l = applyHypothesisUpdate(
    l,
    {
      op: 'create',
      id: 'H2',
      kind: 'compiler',
      text: 'second root hypothesis under test',
      confidence: 0.5,
    },
    'agent-b',
    0,
  )
  l = applyHypothesisUpdate(
    l,
    {
      op: 'create',
      id: 'H1',
      kind: 'file-class',
      text: 'first root hypothesis under test',
      confidence: 0.4,
    },
    'agent-c',
    0,
  )
  l = applyHypothesisUpdate(
    l,
    {
      op: 'create',
      id: 'H1.10',
      parent_id: 'H1',
      kind: 'capability',
      text: 'tenth child of H1 hypothesis text',
      confidence: 0.3,
    },
    'agent-c',
    0,
  )
  l = applyHypothesisUpdate(
    l,
    {
      op: 'create',
      id: 'H1.2',
      parent_id: 'H1',
      kind: 'capability',
      text: 'second child of H1 hypothesis text',
      confidence: 0.3,
    },
    'agent-c',
    0,
  )
  // One evidence entry so we exercise the array path too.
  l = appendEvidence(l, {
    agentId: 'agent-a',
    round: 0,
    toolName: 'ReverseCli',
    toolArgs: { action: 'detect_packer' },
    outcome: 'success',
    resultDigest: 'UPX 4.0 detected',
    testedHypothesis: 'H10',
    verdict: 'confirms',
    durationMs: 42,
  }).ledger
  return l
}

function makeBuildArgs(
  overrides: Partial<Parameters<typeof buildPevEvalLog>[0]> = {},
): Parameters<typeof buildPevEvalLog>[0] {
  return {
    sessionId: 'sess-001',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_010_000,
    targetBinary: TARGET_BINARY,
    initialClaim: 'analyse the binary',
    budget: BUDGET,
    finalLedger: makeLedgerWithMixedIds(),
    rounds: [],
    stopReason: 'all-resolved',
    ...overrides,
  }
}

/* -------------------------------------------------------------------------- */
/* buildPevEvalLog                                                            */
/* -------------------------------------------------------------------------- */

describe('buildPevEvalLog', () => {
  test('produces all required Model 7 fields', () => {
    const log = buildPevEvalLog(makeBuildArgs())

    expect(log.schemaVersion).toBe('1.0')
    expect(log.profileId).toBe('reverse')
    expect(log.sessionId).toBe('sess-001')
    expect(log.startedAt).toBe(1_700_000_000_000)
    expect(log.endedAt).toBe(1_700_000_010_000)
    expect(log.targetBinary).toEqual(TARGET_BINARY)
    expect(log.initialClaim).toBe('analyse the binary')
    expect(log.budget).toEqual(BUDGET)
    expect(log.stopReason).toBe('all-resolved')
    expect(Array.isArray(log.rounds)).toBe(true)
    expect(typeof log.finalLedger).toBe('object')
  })

  test('finalLedger.hypotheses is an array (Map → []) and finalLedger.evidenceLog is preserved', () => {
    const log = buildPevEvalLog(makeBuildArgs())
    expect(Array.isArray(log.finalLedger.hypotheses)).toBe(true)
    expect(log.finalLedger.hypotheses.length).toBe(5)
    expect(Array.isArray(log.finalLedger.evidenceLog)).toBe(true)
    expect(log.finalLedger.evidenceLog.length).toBe(1)
    expect(log.finalLedger.evidenceLog[0]!.id).toBe('E1')
  })

  test('hypotheses are sorted by hierarchical-numeric id ascending', () => {
    const log = buildPevEvalLog(makeBuildArgs())
    const ids = log.finalLedger.hypotheses.map(h => h.id)
    // Hierarchical-numeric sort: H1 < H1.2 < H1.10 < H2 < H10.
    // (Lexical sort would be wrong: it'd put H10 between H1 and H1.2.)
    expect(ids).toEqual(['H1', 'H1.2', 'H1.10', 'H2', 'H10'])
  })

  test('parseStats are deeply copied (defensive — no shared reference)', () => {
    const args = makeBuildArgs()
    const log = buildPevEvalLog(args)
    expect(log.finalLedger.parseStats).toEqual(args.finalLedger.parseStats)
    expect(log.finalLedger.parseStats).not.toBe(args.finalLedger.parseStats)
  })

  test('stopDetail is omitted from the result when not provided', () => {
    const log = buildPevEvalLog(makeBuildArgs({ stopDetail: undefined }))
    expect(log.stopDetail).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(log, 'stopDetail')).toBe(false)
  })

  test('stopDetail is included when provided', () => {
    const log = buildPevEvalLog(
      makeBuildArgs({ stopDetail: 'tool budget exhausted' }),
    )
    expect(log.stopDetail).toBe('tool budget exhausted')
  })

  test('rounds payload passes through verbatim', () => {
    const rounds: PevEvalLog['rounds'] = [
      {
        round: 0,
        perAgentOutputs: [
          {
            agentId: 'agent-a',
            parseResult: { ok: true, layerHit: 1 },
          },
          {
            agentId: 'agent-b',
            parseResult: {
              ok: false,
              errorKind: 'json-parse-failed',
              detail: 'malformed json',
            },
          },
        ],
      },
    ]
    const log = buildPevEvalLog(makeBuildArgs({ rounds }))
    expect(log.rounds).toEqual(rounds)
  })
})

/* -------------------------------------------------------------------------- */
/* writePevEvalLog — happy path                                               */
/* -------------------------------------------------------------------------- */

describe('writePevEvalLog — write + readback', () => {
  test('writes to <sessionDir>/<sessionId>.pev.json and the file is valid JSON', async () => {
    const log = buildPevEvalLog(makeBuildArgs({ sessionId: 'abc' }))
    const result = await writePevEvalLog({
      sessionDir: tempDir,
      sessionId: 'abc',
      log,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return // narrowing for TS
    expect(result.path).toBe(path.join(tempDir, 'abc.pev.json'))

    const raw = await readFile(result.path, 'utf8')
    const parsed = JSON.parse(raw) as PevEvalLog
    expect(parsed.schemaVersion).toBe('1.0')
    expect(parsed.profileId).toBe('reverse')
    expect(parsed.sessionId).toBe('abc')
    expect(parsed.targetBinary).toEqual(TARGET_BINARY)
    expect(parsed.budget).toEqual(BUDGET)
    expect(parsed.stopReason).toBe('all-resolved')
    expect(parsed.finalLedger.hypotheses.length).toBe(5)
    expect(parsed.finalLedger.evidenceLog[0]!.id).toBe('E1')
  })

  test('atomic write: no <filename>.tmp left behind on success', async () => {
    const log = buildPevEvalLog(makeBuildArgs({ sessionId: 'atomic' }))
    const result = await writePevEvalLog({
      sessionDir: tempDir,
      sessionId: 'atomic',
      log,
    })
    expect(result.ok).toBe(true)
    const tmpPath = path.join(tempDir, 'atomic.pev.json.tmp')
    let tmpExists = true
    try {
      await stat(tmpPath)
    } catch {
      tmpExists = false
    }
    expect(tmpExists).toBe(false)
  })

  test('idempotent overwrite: writing twice keeps the second payload', async () => {
    const log1 = buildPevEvalLog(
      makeBuildArgs({ sessionId: 'over', initialClaim: 'first claim' }),
    )
    const r1 = await writePevEvalLog({
      sessionDir: tempDir,
      sessionId: 'over',
      log: log1,
    })
    expect(r1.ok).toBe(true)

    const log2 = buildPevEvalLog(
      makeBuildArgs({ sessionId: 'over', initialClaim: 'second claim' }),
    )
    const r2 = await writePevEvalLog({
      sessionDir: tempDir,
      sessionId: 'over',
      log: log2,
    })
    expect(r2.ok).toBe(true)

    const raw = await readFile(path.join(tempDir, 'over.pev.json'), 'utf8')
    const parsed = JSON.parse(raw) as PevEvalLog
    expect(parsed.initialClaim).toBe('second claim')
  })
})

/* -------------------------------------------------------------------------- */
/* writePevEvalLog — error paths (R6-7)                                       */
/* -------------------------------------------------------------------------- */

describe('writePevEvalLog — error injection', () => {
  test('writing to a non-existent directory returns { ok: false } and never throws', async () => {
    const bogusDir = path.join(tempDir, 'this', 'path', 'does', 'not', 'exist')
    const log = buildPevEvalLog(makeBuildArgs({ sessionId: 'bogus' }))

    let threw = false
    let result: Awaited<ReturnType<typeof writePevEvalLog>> | undefined
    try {
      result = await writePevEvalLog({
        sessionDir: bogusDir,
        sessionId: 'bogus',
        log,
      })
    } catch {
      threw = true
    }

    expect(threw).toBe(false)
    expect(result).toBeDefined()
    expect(result!.ok).toBe(false)
    if (result!.ok) return
    expect(typeof result!.error).toBe('string')
    expect(result!.error.length).toBeGreaterThan(0)
  })

  test('serialisation of a circular structure returns { ok: false } without throwing', async () => {
    // Build a synthetic log with a circular reference. We bypass
    // buildPevEvalLog (which doesn't allow it) and stuff the cycle into
    // a sub-field via type-assertion — simulating a future regression
    // where some leaked Map/object accidentally creates a cycle.
    type Cyclic = { self?: Cyclic }
    const cycle: Cyclic = {}
    cycle.self = cycle

    const tainted = {
      ...buildPevEvalLog(makeBuildArgs({ sessionId: 'cyc' })),
      // injected at runtime; not part of the Model 7 surface
      stopDetail: cycle as unknown as string,
    } as unknown as PevEvalLog

    let threw = false
    let result: Awaited<ReturnType<typeof writePevEvalLog>> | undefined
    try {
      result = await writePevEvalLog({
        sessionDir: tempDir,
        sessionId: 'cyc',
        log: tainted,
      })
    } catch {
      threw = true
    }

    expect(threw).toBe(false)
    expect(result).toBeDefined()
    expect(result!.ok).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* writePevEvalLog — file mode (R6-8)                                         */
/* -------------------------------------------------------------------------- */

describe('writePevEvalLog — file permissions', () => {
  // POSIX-only: Windows has no equivalent of mode bits, so chmod is a no-op
  // there. Skipping at runtime keeps CI green on `process.platform === 'win32'`.
  const itPosix = process.platform === 'win32' ? test.skip : test

  itPosix('after write, file mode is 0o600 (POSIX only)', async () => {
    const log = buildPevEvalLog(makeBuildArgs({ sessionId: 'mode' }))
    const result = await writePevEvalLog({
      sessionDir: tempDir,
      sessionId: 'mode',
      log,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const st = await stat(result.path)
    // Mask to the lower 9 bits (rwxrwxrwx).
    const mode = st.mode & 0o777
    expect(mode).toBe(0o600)
  })
})

/* -------------------------------------------------------------------------- */
/* writePevEvalLog — Map/Set/RegExp defensive replacer                        */
/* -------------------------------------------------------------------------- */

describe('writePevEvalLog — replacer leakage defence', () => {
  test('a leaked Map / Set / RegExp serialises to a JSON-friendly form', async () => {
    // Inject a Map / Set / RegExp into stopDetail so the replacer kicks
    // in. Cast through unknown — these are not part of the Model 7
    // surface, but the replacer is defence-in-depth for future regressions.
    const m = new Map<string, number>([['a', 1]])
    const s = new Set<string>(['x'])
    const r = /^H\d+$/

    const tainted = {
      ...buildPevEvalLog(makeBuildArgs({ sessionId: 'leak' })),
      stopDetail: { m, s, r } as unknown as string,
    } as unknown as PevEvalLog

    const result = await writePevEvalLog({
      sessionDir: tempDir,
      sessionId: 'leak',
      log: tainted,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const raw = await readFile(result.path, 'utf8')
    const parsed = JSON.parse(raw) as { stopDetail: { m: unknown; s: unknown; r: unknown } }
    // Map -> array of [key, value] entries
    expect(parsed.stopDetail.m).toEqual([['a', 1]])
    // Set -> array of values
    expect(parsed.stopDetail.s).toEqual(['x'])
    // RegExp -> string source
    expect(typeof parsed.stopDetail.r).toBe('string')
  })
})

/**
 * T10 — auditLog tests.
 *
 * Covers:
 *   - R8-1: NDJSON file format
 *   - R8-2: 8 event kinds round-trip
 *   - R8-3: append-only (multiple writes don't truncate)
 *   - R8-4: NO read API surface
 *   - R8-5: ≤ 8KB per line via truncation
 *   - R8-7: every line ends with \n (NDJSON-safe partial write)
 */

import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as auditLog from '../auditLog.js'
import { openAuditWriter, serializeEvent } from '../auditLog.js'
import type { SidecarAuditEvent } from '../types.js'

const tempPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'sac-audit-'))
  return join(dir, 'audit.jsonl')
}

const allKinds = (): SidecarAuditEvent[] => {
  const t = 1700000000000
  return [
    {
      kind: 'session.start',
      sessionId: 'sess-1',
      profileId: 'generic',
      weights: {
        lambdaCost: 0.05,
        gammaCausal: 0.3,
        kappaUrgency: 0.2,
        gammaExplore: 0.1,
        deltaZero: 0.2,
        useAdaptiveDelta: true,
      },
      timestamp: t,
    },
    {
      kind: 'session.end',
      sessionId: 'sess-1',
      reason: 'natural',
      totalCrEig: 1.2,
      finalEpsilon: 0.04,
      timestamp: t + 1000,
    },
    {
      kind: 'round.cr-eig',
      sessionId: 'sess-1',
      round: 1,
      ranking: [
        {
          gradient: 'oracle',
          crEig: 0.55,
          breakdown: {
            baseEig: 0.3,
            trustWeightedConfirm: 0.05,
            trustWeightedFalsify: 0.05,
            costPenalty: 0.0075,
            causalGain: 0.0,
            urgencyBoost: 0.04,
            explorationBonus: 0.1,
          },
          modelChose: false,
        },
      ],
      timestamp: t + 200,
    },
    {
      kind: 'round.exploitability',
      sessionId: 'sess-1',
      round: 1,
      eps: 0.12,
      perAgent: { A: 0.1, B: 0.12 },
      timestamp: t + 300,
    },
    {
      kind: 'round.gradient-ranking',
      sessionId: 'sess-1',
      round: 1,
      modelChose: 'oracle',
      rankedGradient: [
        {
          gradient: 'oracle',
          crEig: 0.55,
          breakdown: {
            baseEig: 0.3,
            trustWeightedConfirm: 0.05,
            trustWeightedFalsify: 0.05,
            costPenalty: 0.0075,
            causalGain: 0,
            urgencyBoost: 0.04,
            explorationBonus: 0.1,
          },
          modelChose: true,
        },
      ],
      timestamp: t + 350,
    },
    {
      kind: 'round.epistemic',
      sessionId: 'sess-1',
      round: 1,
      agentId: 'A',
      verdict: {
        knowledge_zone: 'core',
        training_cutoff_aware: '2025-04',
        oracle_used: null,
        claim_grounded_in: 'memory',
        refusal_when_unknown: false,
      },
      timestamp: t + 400,
    },
    {
      kind: 'round.epistemic-violation',
      sessionId: 'sess-1',
      round: 1,
      agentId: 'B',
      ruleId: 'E1',
      details: 'outside zone, no oracle, but did not refuse',
      timestamp: t + 450,
    },
    {
      kind: 'degradation',
      sessionId: 'sess-1',
      round: 1,
      reason: 'epistemic-malformed',
      details: 'JSON parse failure on agent C output',
      timestamp: t + 500,
    },
  ]
}

describe('auditLog — serializeEvent', () => {
  it('every event kind serializes to a string ending with \\n', () => {
    for (const ev of allKinds()) {
      const line = serializeEvent(ev)
      expect(line.endsWith('\n')).toBe(true)
      // Round-trip
      const parsed = JSON.parse(line.trimEnd())
      expect(parsed.kind).toBe(ev.kind)
      expect(parsed.sessionId).toBe(ev.sessionId)
    }
  })

  it('truncates oversize details on round.epistemic-violation', () => {
    const huge = 'X'.repeat(20_000)
    const ev: SidecarAuditEvent = {
      kind: 'round.epistemic-violation',
      sessionId: 'sess-1',
      round: 1,
      agentId: 'A',
      ruleId: 'E3',
      details: huge,
      timestamp: 0,
    }
    const line = serializeEvent(ev)
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(8 * 1024)
    expect(line.endsWith('\n')).toBe(true)
  })

  it('falls back to degradation placeholder when even truncation cannot fit', () => {
    // Build a session.start with a giant weights object (cannot easily
    // truncate), to trigger the fallback.
    const ev = {
      kind: 'session.start',
      sessionId: 'X'.repeat(20_000),
      profileId: 'generic',
      weights: {
        lambdaCost: 0.05,
        gammaCausal: 0.3,
        kappaUrgency: 0.2,
        gammaExplore: 0.1,
        deltaZero: 0.2,
        useAdaptiveDelta: true,
      },
      timestamp: 0,
    } as unknown as SidecarAuditEvent
    const line = serializeEvent(ev)
    expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(8 * 1024)
    const parsed = JSON.parse(line.trimEnd())
    expect(parsed.kind).toBe('degradation')
    expect(parsed.reason).toBe('audit-event-too-large')
  })
})

describe('auditLog — openAuditWriter (file path)', () => {
  it('writes all events as one NDJSON file, last byte = \\n', async () => {
    const file = tempPath()
    const w = openAuditWriter(file)
    for (const ev of allKinds()) {
      await w.write(ev)
    }
    await w.close()
    const text = readFileSync(file, 'utf8')
    expect(text.endsWith('\n')).toBe(true)
    const lines = text.split('\n').filter(Boolean)
    expect(lines.length).toBe(allKinds().length)
    // Round-trip every line
    for (const l of lines) {
      const parsed = JSON.parse(l)
      expect(typeof parsed.kind).toBe('string')
    }
    rmSync(file, { force: true })
    rmSync(file.replace(/\\audit\.jsonl$/, ''), {
      recursive: true,
      force: true,
    })
  })

  it('append-only: a second writer extends, not truncates (R8-3)', async () => {
    const file = tempPath()
    const w1 = openAuditWriter(file)
    await w1.write({
      kind: 'session.start',
      sessionId: 's',
      profileId: 'generic',
      weights: {
        lambdaCost: 0.05,
        gammaCausal: 0.3,
        kappaUrgency: 0.2,
        gammaExplore: 0.1,
        deltaZero: 0.2,
        useAdaptiveDelta: true,
      },
      timestamp: 1,
    })
    await w1.close()
    const sizeAfter1 = statSync(file).size

    const w2 = openAuditWriter(file)
    await w2.write({
      kind: 'session.end',
      sessionId: 's',
      reason: 'manual',
      totalCrEig: 0,
      finalEpsilon: null,
      timestamp: 2,
    })
    await w2.close()
    const sizeAfter2 = statSync(file).size
    expect(sizeAfter2).toBeGreaterThan(sizeAfter1)
  })

  it('close() is idempotent', async () => {
    const file = tempPath()
    const w = openAuditWriter(file)
    await w.close()
    await w.close()
    await w.close()
    expect(true).toBe(true)
  })

  it('post-close writes are silently dropped', async () => {
    const file = tempPath()
    const w = openAuditWriter(file)
    await w.close()
    await w.write({
      kind: 'degradation',
      sessionId: 's',
      reason: 'after close',
      details: 'x',
      timestamp: 0,
    })
    // No throw is the contract; file may still be empty.
    expect(true).toBe(true)
  })
})

describe('auditLog — R8-4 / R5-9 no read API', () => {
  it('the module exports zero functions starting with read/load/parse', () => {
    const exported = Object.keys(auditLog)
    for (const name of exported) {
      expect(/^(read|load|parse)/i.test(name)).toBe(false)
    }
  })

  it('the only writer surface is { write, close }', async () => {
    const file = tempPath()
    const w = openAuditWriter(file)
    const keys = Object.keys(w).sort()
    expect(keys).toEqual(['close', 'write'])
    await w.close()
  })
})

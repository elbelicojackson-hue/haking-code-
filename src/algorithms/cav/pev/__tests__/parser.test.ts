/**
 * PEV Parser — unit tests covering the three-layer fault-tolerant pipeline.
 *
 * Coverage map (per task T3 DoD + R5-1 ~ R5-8):
 *   - Corpus-driven: every entry in `__corpus__/manifest.ts` is parsed
 *     with the documented ledger context and asserted against its
 *     expected outcome (layer hit or error kind).
 *   - Layer 1 happy path: minimal valid PEV output → layerHit === 1.
 *   - Layer 2 happy paths (× 5): one per repair feature (trailing comma,
 *     single quote, unquoted keys, missing schema_version, camelCase
 *     keys).
 *   - Layer 3 retry success: mock `retryFn` ships a corrected version,
 *     parser returns layerHit === 3.
 *   - Layer 3 retry exhausted: mock `retryFn` ships another bad payload,
 *     parser returns errorKind === 'retry-exhausted'.
 *   - No fenced block: Layer 1 / Layer 2 short-circuit, Layer 3 still
 *     attempted when retryFn is provided.
 *   - ParseStats counter correctly increments across L1/L2/L3/failure.
 *   - Secret redaction: feedback never echoes `Bearer xxx` or `sk-…`
 *     tokens (R5-8).
 *
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.5, 5.7, 5.8
 */

import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  buildErrorFeedback,
  createEmptyParseStats,
  extractFencedBlock,
  normaliseKeys,
  parseLenientJson,
  parsePevOutput,
  redactSecrets,
  removeJsCommentsAndTrailingCommas,
  type ParserContext,
  type ParseStats,
} from '../parser.js'
import type { LedgerView } from '../validator.js'
import { CORPUS, type LedgerKey } from './__corpus__/manifest.js'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const CORPUS_DIR = path.join(__dirname, '__corpus__')

/** Build a {@link LedgerView} for the named canonical setup. */
function makeLedger(key: LedgerKey): LedgerView {
  switch (key) {
    case 'empty':
      return { hypotheses: new Map(), evidenceLog: [] }
    case 'seeded': {
      const hypotheses = new Map<
        string,
        { id: string; status: 'open'; confidence: number }
      >()
      hypotheses.set('H1', { id: 'H1', status: 'open', confidence: 0.7 })
      return { hypotheses, evidenceLog: [{ id: 'E1' }] }
    }
  }
}

/** Standard parser context used for all corpus samples. */
function makeCtx(ledger: LedgerView): ParserContext {
  return {
    selfAgentId: 'static_analyst',
    round: 0,
    ledger,
  }
}

/** Read a corpus file, returning its raw contents (LF as written on disk). */
function readCorpus(file: string): string {
  return fs.readFileSync(path.join(CORPUS_DIR, file), 'utf8')
}

/* -------------------------------------------------------------------------- */
/* Corpus-driven tests                                                        */
/* -------------------------------------------------------------------------- */

describe('parsePevOutput — corpus', () => {
  // Sanity: at least the documented 20 samples are committed.
  test('corpus has at least 20 samples committed', () => {
    const files = fs
      .readdirSync(CORPUS_DIR)
      .filter(f => f.endsWith('.md') || f.endsWith('.txt'))
    expect(files.length).toBeGreaterThanOrEqual(20)
  })

  // Sanity: every entry in the manifest has a corresponding file on disk.
  test('every manifest entry has a file on disk', () => {
    for (const entry of CORPUS) {
      const p = path.join(CORPUS_DIR, entry.file)
      expect(fs.existsSync(p)).toBe(true)
    }
  })

  for (const entry of CORPUS) {
    test(`${entry.file} — ${entry.label}`, async () => {
      // The CRLF edge case is the only sample that has to be massaged at
      // load time — everything else goes in verbatim.
      let raw = readCorpus(entry.file)
      if (entry.file === 'EDGE_01_crlf.md') {
        raw = raw.replace(/\r?\n/g, '\r\n')
      }

      const ledger = makeLedger(entry.ledger)
      const result = await parsePevOutput(raw, makeCtx(ledger))

      if (entry.expected.kind === 'ok') {
        if (!result.ok) {
          throw new Error(
            `[${entry.file}] expected ok, got errorKind=${result.errorKind}: ${result.detail}`,
          )
        }
        expect(result.layerHit).toBe(entry.expected.layerHit)
      } else {
        if (result.ok) {
          throw new Error(
            `[${entry.file}] expected err but parser returned ok at layer ${result.layerHit}`,
          )
        }
        expect(result.errorKind).toBe(entry.expected.errorKind as never)
      }
    })
  }
})

/* -------------------------------------------------------------------------- */
/* Coverage targets — DoD                                                     */
/* -------------------------------------------------------------------------- */

describe('parsePevOutput — coverage targets', () => {
  test('Layer-1 hit rate over the 5 happy samples is 100%', async () => {
    const happy = CORPUS.filter(
      e => e.expected.kind === 'ok' && e.expected.layerHit === 1,
    )
    expect(happy.length).toBeGreaterThanOrEqual(5)
    let layer1 = 0
    for (const entry of happy) {
      let raw = readCorpus(entry.file)
      if (entry.file === 'EDGE_01_crlf.md') raw = raw.replace(/\r?\n/g, '\r\n')
      const result = await parsePevOutput(raw, makeCtx(makeLedger(entry.ledger)))
      if (result.ok && result.layerHit === 1) layer1 += 1
    }
    expect(layer1).toBe(happy.length)
  })

  test('cumulative L1+L2+L3 hit rate over the corpus ≥ 99% for ok-expected entries', async () => {
    const okExpected = CORPUS.filter(e => e.expected.kind === 'ok')
    let hits = 0
    for (const entry of okExpected) {
      let raw = readCorpus(entry.file)
      if (entry.file === 'EDGE_01_crlf.md') raw = raw.replace(/\r?\n/g, '\r\n')
      const result = await parsePevOutput(raw, makeCtx(makeLedger(entry.ledger)))
      if (result.ok) hits += 1
    }
    expect(hits / okExpected.length).toBeGreaterThanOrEqual(0.99)
  })
})

/* -------------------------------------------------------------------------- */
/* Layer 1 — strict path                                                       */
/* -------------------------------------------------------------------------- */

describe('parsePevOutput — Layer 1', () => {
  test('minimal valid output → layerHit=1', async () => {
    const raw = [
      '## 1. 内容',
      'no signal yet',
      '',
      '```pev',
      JSON.stringify({
        schema_version: '1.0',
        agent_id: 'a1',
        round: 7,
        observations: [],
        hypothesis_updates: [],
        next_action: { kind: 'observe_only', rationale: 'waiting' },
      }),
      '```',
      '',
      '```cav',
      '{}',
      '```',
    ].join('\n')

    const result = await parsePevOutput(raw, {
      selfAgentId: 'a1',
      round: 7,
      ledger: { hypotheses: new Map(), evidenceLog: [] },
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.layerHit).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Layer 2 — repair path (one per repair feature)                              */
/* -------------------------------------------------------------------------- */

describe('parsePevOutput — Layer 2 repair features', () => {
  const ledger: LedgerView = { hypotheses: new Map(), evidenceLog: [] }
  const ctx: ParserContext = { selfAgentId: 'a1', round: 0, ledger }

  test('trailing comma is repaired', async () => {
    const raw = [
      '```pev',
      '{',
      '  "schema_version": "1.0",',
      '  "agent_id": "a1",',
      '  "round": 0,',
      '  "observations": [],',
      '  "hypothesis_updates": [],',
      '  "next_action": { "kind": "observe_only", "rationale": "waiting", },',
      '}',
      '```',
    ].join('\n')
    const result = await parsePevOutput(raw, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.layerHit).toBe(2)
  })

  test('single-quoted strings are repaired', async () => {
    const raw = [
      '```pev',
      "{ 'schema_version': '1.0', 'agent_id': 'a1', 'round': 0, 'observations': [], 'hypothesis_updates': [], 'next_action': { 'kind': 'observe_only', 'rationale': 'waiting' } }",
      '```',
    ].join('\n')
    const result = await parsePevOutput(raw, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.layerHit).toBe(2)
  })

  test('unquoted object keys are repaired', async () => {
    const raw = [
      '```pev',
      '{ schema_version: "1.0", agent_id: "a1", round: 0, observations: [], hypothesis_updates: [], next_action: { kind: "observe_only", rationale: "waiting" } }',
      '```',
    ].join('\n')
    const result = await parsePevOutput(raw, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.layerHit).toBe(2)
  })

  test('missing schema_version is auto-injected', async () => {
    const raw = [
      '```pev',
      '{',
      '  "agent_id": "a1",',
      '  "round": 0,',
      '  "observations": [],',
      '  "hypothesis_updates": [],',
      '  "next_action": { "kind": "observe_only", "rationale": "waiting" }',
      '}',
      '```',
    ].join('\n')
    const result = await parsePevOutput(raw, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.layerHit).toBe(2)
      expect(result.parsed.schema_version).toBe('1.0')
    }
  })

  test('camelCase keys are normalised to snake_case', async () => {
    const raw = [
      '```pev',
      JSON.stringify({
        schemaVersion: '1.0',
        agentId: 'a1',
        round: 0,
        observations: [],
        hypothesisUpdates: [],
        nextAction: { kind: 'observe_only', rationale: 'waiting' },
      }),
      '```',
    ].join('\n')
    const result = await parsePevOutput(raw, ctx)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.layerHit).toBe(2)
  })
})

/* -------------------------------------------------------------------------- */
/* Layer 3 — single retry                                                      */
/* -------------------------------------------------------------------------- */

describe('parsePevOutput — Layer 3 retry', () => {
  const ledger: LedgerView = { hypotheses: new Map(), evidenceLog: [] }
  const ctx: ParserContext = { selfAgentId: 'a1', round: 0, ledger }

  test('retry returns a corrected version → layerHit=3', async () => {
    const broken = '## 1. 内容\nbroken sample, no fenced block here\n'
    const corrected = [
      '```pev',
      JSON.stringify({
        schema_version: '1.0',
        agent_id: 'a1',
        round: 0,
        observations: [],
        hypothesis_updates: [],
        next_action: { kind: 'observe_only', rationale: 'waiting' },
      }),
      '```',
    ].join('\n')

    let calls = 0
    const retryFn = async (_feedback: string): Promise<string> => {
      calls += 1
      return corrected
    }

    const result = await parsePevOutput(broken, ctx, retryFn)
    expect(calls).toBe(1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.layerHit).toBe(3)
  })

  test('retry returns garbage twice → retry-exhausted', async () => {
    const broken = '## 1. 内容\nno fenced block\n'
    let calls = 0
    const retryFn = async (_feedback: string): Promise<string> => {
      calls += 1
      // Still no fenced block.
      return '## 1. 内容\nstill nothing useful\n'
    }
    const result = await parsePevOutput(broken, ctx, retryFn)
    expect(calls).toBe(1)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorKind).toBe('retry-exhausted')
  })

  test('retry callback is invoked at most once', async () => {
    const broken = 'no fenced block here either'
    let calls = 0
    const retryFn = async (_feedback: string): Promise<string> => {
      calls += 1
      return 'still no fenced block'
    }
    await parsePevOutput(broken, ctx, retryFn)
    await parsePevOutput(broken, ctx, retryFn) // second top-level call
    // Each top-level call is allowed exactly one retry.
    expect(calls).toBe(2)
  })

  test('retry callback that throws → retry-exhausted with safe detail', async () => {
    const broken = 'no fenced block'
    const retryFn = async (_feedback: string): Promise<string> => {
      throw new Error('network down: Authorization: Bearer abc123secret')
    }
    const result = await parsePevOutput(broken, ctx, retryFn)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errorKind).toBe('retry-exhausted')
      // Bearer token MUST be redacted.
      expect(result.detail).not.toContain('Bearer abc123secret')
      expect(result.detail).toContain('Bearer ***')
    }
  })
})

/* -------------------------------------------------------------------------- */
/* No fenced block                                                             */
/* -------------------------------------------------------------------------- */

describe('parsePevOutput — no fenced block', () => {
  test('returns no-fenced-block error without retryFn', async () => {
    const ledger: LedgerView = { hypotheses: new Map(), evidenceLog: [] }
    const ctx: ParserContext = { selfAgentId: 'a1', round: 0, ledger }
    const result = await parsePevOutput('only prose, no fences', ctx)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errorKind).toBe('no-fenced-block')
  })
})

/* -------------------------------------------------------------------------- */
/* ParseStats counter                                                          */
/* -------------------------------------------------------------------------- */

describe('parsePevOutput — parseStats counter', () => {
  test('layer1Hits increments on Layer-1 success', async () => {
    const stats = createEmptyParseStats()
    const ledger: LedgerView = { hypotheses: new Map(), evidenceLog: [] }
    const ctx: ParserContext = { selfAgentId: 'a1', round: 0, ledger }
    const raw = [
      '```pev',
      JSON.stringify({
        schema_version: '1.0',
        agent_id: 'a1',
        round: 0,
        observations: [],
        hypothesis_updates: [],
        next_action: { kind: 'observe_only', rationale: 'waiting' },
      }),
      '```',
    ].join('\n')
    await parsePevOutput(raw, ctx, undefined, stats)
    expect(stats.layer1Hits).toBe(1)
    expect(stats.layer2Hits).toBe(0)
    expect(stats.layer3Hits).toBe(0)
    expect(stats.parseFailures).toBe(0)
  })

  test('layer2Hits increments on Layer-2 repair', async () => {
    const stats = createEmptyParseStats()
    const ledger: LedgerView = { hypotheses: new Map(), evidenceLog: [] }
    const ctx: ParserContext = { selfAgentId: 'a1', round: 0, ledger }
    const raw = [
      '```pev',
      "{ 'schema_version': '1.0', 'agent_id': 'a1', 'round': 0, 'observations': [], 'hypothesis_updates': [], 'next_action': { 'kind': 'observe_only', 'rationale': 'waiting' } }",
      '```',
    ].join('\n')
    await parsePevOutput(raw, ctx, undefined, stats)
    expect(stats.layer2Hits).toBe(1)
    expect(stats.layer1Hits).toBe(0)
    expect(stats.parseFailures).toBe(0)
  })

  test('layer3Hits increments on Layer-3 retry success', async () => {
    const stats = createEmptyParseStats()
    const ledger: LedgerView = { hypotheses: new Map(), evidenceLog: [] }
    const ctx: ParserContext = { selfAgentId: 'a1', round: 0, ledger }
    const corrected = [
      '```pev',
      JSON.stringify({
        schema_version: '1.0',
        agent_id: 'a1',
        round: 0,
        observations: [],
        hypothesis_updates: [],
        next_action: { kind: 'observe_only', rationale: 'waiting' },
      }),
      '```',
    ].join('\n')
    await parsePevOutput(
      'no fenced block here',
      ctx,
      async () => corrected,
      stats,
    )
    expect(stats.layer3Hits).toBe(1)
    expect(stats.parseFailures).toBe(0)
  })

  test('parseFailures increments when all layers fail', async () => {
    const stats = createEmptyParseStats()
    const ledger: LedgerView = { hypotheses: new Map(), evidenceLog: [] }
    const ctx: ParserContext = { selfAgentId: 'a1', round: 0, ledger }
    await parsePevOutput('no fenced block, no retry', ctx, undefined, stats)
    expect(stats.parseFailures).toBe(1)
  })

  test('cumulative counts across multiple calls', async () => {
    const stats = createEmptyParseStats()
    const ledger: LedgerView = { hypotheses: new Map(), evidenceLog: [] }
    const ctx: ParserContext = { selfAgentId: 'a1', round: 0, ledger }
    // Layer 1 ×2.
    for (let i = 0; i < 2; i++) {
      const raw = [
        '```pev',
        JSON.stringify({
          schema_version: '1.0',
          agent_id: 'a1',
          round: 0,
          observations: [],
          hypothesis_updates: [],
          next_action: { kind: 'observe_only', rationale: 'waiting' },
        }),
        '```',
      ].join('\n')
      await parsePevOutput(raw, ctx, undefined, stats)
    }
    // Layer 2 ×1.
    await parsePevOutput(
      [
        '```pev',
        "{ 'schema_version': '1.0', 'agent_id': 'a1', 'round': 0, 'observations': [], 'hypothesis_updates': [], 'next_action': { 'kind': 'observe_only', 'rationale': 'waiting' } }",
        '```',
      ].join('\n'),
      ctx,
      undefined,
      stats,
    )
    // Failure ×1.
    await parsePevOutput('nothing here', ctx, undefined, stats)

    expect(stats.layer1Hits).toBe(2)
    expect(stats.layer2Hits).toBe(1)
    expect(stats.layer3Hits).toBe(0)
    expect(stats.parseFailures).toBe(1)
  })
})

/* -------------------------------------------------------------------------- */
/* Redaction (R5-8)                                                            */
/* -------------------------------------------------------------------------- */

describe('redactSecrets / buildErrorFeedback', () => {
  test('Bearer tokens are masked', () => {
    const out = redactSecrets('Authorization: Bearer abc.def-ghi=123')
    expect(out).not.toContain('abc.def-ghi=123')
    expect(out).toContain('Bearer ***')
  })

  test('sk- API keys are masked', () => {
    const out = redactSecrets('key=sk-1234567890abcdef and sk-proj-abcdefghij')
    expect(out).not.toContain('sk-1234567890abcdef')
    expect(out).not.toContain('sk-proj-abcdefghij')
    expect(out).toContain('sk-***')
  })

  test('api-key headers are masked', () => {
    const out = redactSecrets('x-api-key: AKIA1234567890XYZ-secret')
    expect(out).not.toContain('AKIA1234567890XYZ-secret')
    expect(out).toMatch(/api[-_]?key/i)
  })

  test('buildErrorFeedback never echoes a Bearer substring', () => {
    const fb = buildErrorFeedback(
      'json-parse-failed',
      'fetch failed: Authorization: Bearer abc123secret456=',
    )
    expect(fb).not.toContain('Bearer abc123secret456=')
    expect(fb).toContain('Bearer ***')
    // Sanity: the feedback string still names the kind + protocol hints.
    expect(fb).toContain('json-parse-failed')
    expect(fb).toContain('schema_version')
    expect(fb).toContain('snake_case')
  })

  test('buildErrorFeedback does not echo the raw non-conforming output', () => {
    // The feedback must NOT include any "raw json dump" of the user's
    // previous bad output — the runner passes a `detail` summary, never
    // the full block. We verify that by feeding a recognisable marker
    // string in `detail` and checking it shows up only inside the
    // detail line, never embedded in a fenced JSON block.
    const marker = '<<<RAW_BAD_OUTPUT_MARKER>>>'
    const fb = buildErrorFeedback('schema-mismatch', `field foo: ${marker}`)
    // The marker is allowed to appear (because it was passed in detail),
    // but it must NOT be wrapped in a json/pev fence inside feedback.
    expect(fb).not.toMatch(new RegExp('```\\w*\\s*\\n[\\s\\S]*' + marker.replace(/[<>]/g, '\\$&') + '[\\s\\S]*\\n```'))
  })
})

/* -------------------------------------------------------------------------- */
/* Internal helpers (white-box)                                                */
/* -------------------------------------------------------------------------- */

describe('extractFencedBlock', () => {
  test('extracts a single ```pev block', () => {
    const raw = '## prose\n\n```pev\n{"a":1}\n```\n\n```cav\n{}\n```\n'
    expect(extractFencedBlock(raw, 'pev')).toBe('{"a":1}')
  })

  test('returns null when language tag mismatches', () => {
    const raw = '```json\n{"a":1}\n```\n'
    expect(extractFencedBlock(raw, 'pev')).toBeNull()
  })

  test('tolerates CRLF line endings', () => {
    const raw = '```pev\r\n{"a":1}\r\n```\r\n'
    expect(extractFencedBlock(raw, 'pev')).toBe('{"a":1}')
  })

  test('tolerates a trailing info string (```pev json)', () => {
    const raw = '```pev json\n{"a":1}\n```\n'
    expect(extractFencedBlock(raw, 'pev')).toBe('{"a":1}')
  })
})

describe('removeJsCommentsAndTrailingCommas', () => {
  test('strips // line comments', () => {
    const out = removeJsCommentsAndTrailingCommas('{ "a": 1 // hi\n, "b": 2 }')
    expect(out).not.toContain('// hi')
  })

  test('strips /* */ block comments', () => {
    const out = removeJsCommentsAndTrailingCommas('{ /* meta */ "a": 1 }')
    expect(out).not.toContain('meta')
  })

  test('removes trailing commas before } and ]', () => {
    const out = removeJsCommentsAndTrailingCommas('{ "a": [1,2,], "b": 3, }')
    expect(out).toBe('{ "a": [1,2], "b": 3 }')
  })

  test('preserves comment-like text inside string literals', () => {
    const out = removeJsCommentsAndTrailingCommas('{ "url": "http://x.io/path" }')
    expect(out).toBe('{ "url": "http://x.io/path" }')
  })
})

describe('parseLenientJson', () => {
  test('accepts trailing commas', () => {
    expect(parseLenientJson('[1, 2, 3,]')).toEqual([1, 2, 3])
  })

  test('accepts single-quoted strings', () => {
    expect(parseLenientJson("{'a': 'b'}")).toEqual({ a: 'b' })
  })

  test('accepts unquoted object keys', () => {
    expect(parseLenientJson('{ a: 1, b: "two" }')).toEqual({ a: 1, b: 'two' })
  })

  test('accepts // and /* */ comments', () => {
    expect(
      parseLenientJson('{ /* x */ a: 1, b: 2 // trailing\n }'),
    ).toEqual({ a: 1, b: 2 })
  })

  test('rejects truly broken JSON', () => {
    expect(() => parseLenientJson('{ a: ##garbled## }')).toThrow()
  })
})

describe('normaliseKeys', () => {
  test('renames known camelCase keys to snake_case', () => {
    const input = {
      schemaVersion: '1.0',
      agentId: 'x',
      hypothesisUpdates: [{ rationaleShort: 'r', newId: 'H1.1' }],
      nextAction: { hypothesisId: 'H1', toolPlanId: 'p::s', argsOverride: null },
    }
    const out = normaliseKeys(input) as Record<string, unknown>
    expect(out.schema_version).toBe('1.0')
    expect(out.agent_id).toBe('x')
    expect((out.hypothesis_updates as ReadonlyArray<Record<string, unknown>>)[0]).toEqual({
      rationale_short: 'r',
      new_id: 'H1.1',
    })
    const na = out.next_action as Record<string, unknown>
    expect(na.hypothesis_id).toBe('H1')
    expect(na.tool_plan_id).toBe('p::s')
    expect(na.args_override).toBe(null)
  })

  test('passes through unknown keys verbatim', () => {
    const input = { unknownKey: 'leaveMe' }
    expect(normaliseKeys(input)).toEqual({ unknownKey: 'leaveMe' })
  })
})

/* -------------------------------------------------------------------------- */
/* Stat-counter shape sanity                                                  */
/* -------------------------------------------------------------------------- */

describe('createEmptyParseStats', () => {
  test('returns all zeros', () => {
    const s: ParseStats = createEmptyParseStats()
    expect(s).toEqual({
      layer1Hits: 0,
      layer2Hits: 0,
      layer3Hits: 0,
      parseFailures: 0,
    })
  })
})

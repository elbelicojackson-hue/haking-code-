/**
 * VerdictEngine — corpus-driven unit tests + property-based tests.
 *
 * Coverage map (per task T6 DoD + R8-1 ~ R8-8):
 *   - Corpus driven: 12 stdout files in `__corpus__/tool-stdout/` are
 *     each mapped to a canonical plan id and an expected verdict;
 *     {@link judgeVerdict} is run and its result asserted.
 *   - Pattern-conflict: a synthetic stdout that triggers BOTH a
 *     confirms and a falsifies regex; the engine surfaces
 *     `matchedPattern === 'pattern-conflict'`.
 *   - Truncation: a 1.5 MB synthesised string where the trigger pattern
 *     only appears past the 100 KB cut; the engine returns
 *     `truncated === true` and reflects only the first 100 KB.
 *   - Exit-code != 0 with no pattern match → `inconclusive` +
 *     `matchedPattern === null`.
 *   - PBT (fast-check, 200 runs) — Property 9: referential transparency.
 *     Calling {@link judgeVerdict} twice with the same arguments returns
 *     deeply-equal results.
 *
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8
 */

import { describe, expect, test } from 'bun:test'
import * as fc from 'fast-check'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { findToolPlan, type ToolPlan } from '../canonicalTests.js'
import {
  PATTERN_CONFLICT_SENTINEL,
  TRUNCATE_TARGET,
  TRUNCATE_THRESHOLD,
  judgeVerdict,
  type VerdictResult,
} from '../verdict.js'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const CORPUS_DIR = path.join(__dirname, '__corpus__', 'tool-stdout')

/** Read a corpus stdout file. LF on disk; preserved as-written. */
function readCorpus(file: string): string {
  return fs.readFileSync(path.join(CORPUS_DIR, file), 'utf8')
}

/** Resolve a plan by id and fail loudly if missing — keeps tests honest. */
function plan(id: string): ToolPlan {
  const p = findToolPlan(id)
  if (!p) throw new Error(`canonical plan not found: ${id}`)
  return p
}

/**
 * Corpus mapping: each entry maps a real-world stdout sample to the
 * canonical plan it was meant to judge, and the expected outcome.
 *
 * Two notes on the file ↔ plan pairing:
 *   - `compiler-file-pe.txt` paired with `compiler::dnspy-probe`: the
 *     stdout is a vanilla PE (no Mono/.Net), which legitimately
 *     *falsifies* the ".NET assembly" hypothesis (matches the falsifies
 *     regex `/PE32\+?\s+executable\s+\(console\)\s+Intel\s+80386/`). So
 *     the file's role is "negative example of a .NET binary".
 *   - `compiler-file-dotnet.txt` paired with `compiler::dnspy-probe`:
 *     the stdout contains BOTH the `Mono/.Net assembly` confirms marker
 *     AND the `PE32 executable (console) Intel 80386` prefix that the
 *     falsifies regex matches. This is a naturally-occurring
 *     pattern-conflict and exercises R8-5 with a real corpus file
 *     instead of a synthetic string.
 *   - `inconclusive-empty.txt` paired with `family::strings-grep`: that
 *     plan has malware-name confirms regexes and an EMPTY falsifies
 *     array, so empty stdout produces neither match → inconclusive
 *     (null). Most other plans have `^\s*$` in falsifies, which would
 *     turn an empty stdout into a falsify hit instead.
 */
type CorpusCase = {
  file: string
  planId: string
  expected: 'confirms' | 'falsifies' | 'inconclusive'
  /** When set, asserts the matchedPattern equals this exact source string. */
  expectedMatchedPattern?: string | null
}

const CORPUS_CASES: readonly CorpusCase[] = [
  // packer family
  {
    file: 'packer-diec-upx-detect.txt',
    planId: 'packer::diec',
    expected: 'confirms',
  },
  {
    file: 'packer-diec-not-packed.txt',
    planId: 'packer::diec',
    expected: 'falsifies',
  },
  {
    file: 'packer-upx-tested-ok.txt',
    planId: 'packer::upx-test',
    expected: 'confirms',
  },
  {
    file: 'packer-upx-not-packed.txt',
    planId: 'packer::upx-test',
    expected: 'falsifies',
  },
  // compiler family
  {
    file: 'compiler-file-pe.txt',
    planId: 'compiler::dnspy-probe',
    expected: 'falsifies',
  },
  {
    // Real corpus that naturally triggers BOTH confirms (Mono/.Net) and
    // falsifies (PE32 console prefix). Exercises R8-5 directly.
    file: 'compiler-file-dotnet.txt',
    planId: 'compiler::dnspy-probe',
    expected: 'inconclusive',
    expectedMatchedPattern: PATTERN_CONFLICT_SENTINEL,
  },
  {
    file: 'compiler-go-build-id.txt',
    planId: 'compiler::go-probe',
    expected: 'confirms',
  },
  // anti-analysis family
  {
    file: 'anti-analysis-strings-isdebugger.txt',
    planId: 'anti-analysis::strings-grep',
    expected: 'confirms',
  },
  {
    file: 'anti-analysis-strings-clean.txt',
    planId: 'anti-analysis::strings-grep',
    expected: 'falsifies',
  },
  // family detection
  {
    file: 'family-yara-match.txt',
    planId: 'family::yara-scan',
    expected: 'confirms',
  },
  {
    file: 'family-yara-no-match.txt',
    planId: 'family::yara-scan',
    expected: 'falsifies',
  },
  // inconclusive (no pattern match in either direction)
  {
    file: 'inconclusive-empty.txt',
    planId: 'family::strings-grep',
    expected: 'inconclusive',
    expectedMatchedPattern: null,
  },
] as const

/* -------------------------------------------------------------------------- */
/* Corpus-driven coverage                                                     */
/* -------------------------------------------------------------------------- */

describe('judgeVerdict — corpus coverage', () => {
  test('corpus has at least 12 real-tool stdout samples on disk', () => {
    const onDisk = fs
      .readdirSync(CORPUS_DIR)
      .filter(f => f.endsWith('.txt'))
    expect(onDisk.length).toBeGreaterThanOrEqual(12)
  })

  for (const c of CORPUS_CASES) {
    test(`${c.file} → ${c.expected} (plan ${c.planId})`, () => {
      const text = readCorpus(c.file)
      const result = judgeVerdict(plan(c.planId), text, 0)
      expect(result.verdict).toBe(c.expected)
      if (c.expectedMatchedPattern !== undefined) {
        expect(result.matchedPattern).toBe(c.expectedMatchedPattern)
      }
      // Corpus is < 1 MB so truncation must always be false here.
      expect(result.truncated).toBe(false)
    })
  }
})

/* -------------------------------------------------------------------------- */
/* Pattern conflict (R8-5) — synthetic too, in addition to the corpus case    */
/* -------------------------------------------------------------------------- */

describe('judgeVerdict — pattern-conflict (R8-5)', () => {
  test('synthetic stdout with both confirms+falsifies markers → inconclusive + sentinel', () => {
    // packer::diec confirms /UPX|...|/, falsifies /not\s+packed/.
    const stdout = 'Detected: UPX(4.0)\nNote: not packed (sentinel)'
    const result = judgeVerdict(plan('packer::diec'), stdout, 0)
    expect(result.verdict).toBe('inconclusive')
    expect(result.matchedPattern).toBe(PATTERN_CONFLICT_SENTINEL)
    expect(result.truncated).toBe(false)
  })

  test('matchedPattern === sentinel even when exitCode === 0', () => {
    const stdout = 'UPX detected here, but: not packed.'
    const result = judgeVerdict(plan('packer::diec'), stdout, 0)
    expect(result.matchedPattern).toBe(PATTERN_CONFLICT_SENTINEL)
  })

  test('matchedPattern === sentinel even when exitCode !== 0', () => {
    const stdout = 'UPX detected here, but: not packed.'
    const result = judgeVerdict(plan('packer::diec'), stdout, 1)
    expect(result.matchedPattern).toBe(PATTERN_CONFLICT_SENTINEL)
  })
})

/* -------------------------------------------------------------------------- */
/* Truncation (R8-8)                                                          */
/* -------------------------------------------------------------------------- */

describe('judgeVerdict — truncation (R8-8)', () => {
  test('1.5 MB stdout with trigger past 100 KB → truncated && first 100 KB rules', () => {
    // Build a 1.5 MB string where the UPX confirms marker sits AFTER the
    // 100 KB cut, so a truthful judgement on the truncated slice should
    // be 'inconclusive' (first 100 KB has only filler 'a's).
    const fillerHead = 'a'.repeat(TRUNCATE_THRESHOLD + 100_000) // 1.1 MB > threshold
    const triggerTail = '\nPacker: UPX(4.0)[NRV]\n'
    const stdout = fillerHead + triggerTail
    expect(stdout.length).toBeGreaterThan(TRUNCATE_THRESHOLD)
    expect(stdout.length).toBeGreaterThan(TRUNCATE_TARGET)

    const result = judgeVerdict(plan('packer::diec'), stdout, 0)
    expect(result.truncated).toBe(true)
    // The trigger lives at offset > TRUNCATE_TARGET, so the first
    // 100 KB has no matching pattern — verdict must be inconclusive.
    expect(result.verdict).toBe('inconclusive')
    expect(result.matchedPattern).toBe(null)
  })

  test('1.5 MB stdout with trigger inside first 100 KB → truncated && verdict reflects trigger', () => {
    // Build a 1.5 MB string where the UPX confirms marker sits BEFORE
    // the 100 KB cut. Verdict must be 'confirms' because the truncated
    // slice still contains the marker.
    const triggerHead = 'Packer: UPX(4.0)[NRV]\n'
    const filler = 'a'.repeat(TRUNCATE_THRESHOLD + 100_000)
    const stdout = triggerHead + filler
    expect(stdout.length).toBeGreaterThan(TRUNCATE_THRESHOLD)

    const result = judgeVerdict(plan('packer::diec'), stdout, 0)
    expect(result.truncated).toBe(true)
    expect(result.verdict).toBe('confirms')
    expect(result.matchedPattern).not.toBe(null)
  })

  test('exactly TRUNCATE_THRESHOLD chars → NOT truncated (boundary)', () => {
    const stdout = 'b'.repeat(TRUNCATE_THRESHOLD)
    const result = judgeVerdict(plan('packer::diec'), stdout, 0)
    expect(result.truncated).toBe(false)
  })

  test('TRUNCATE_THRESHOLD + 1 chars → truncated (boundary)', () => {
    const stdout = 'b'.repeat(TRUNCATE_THRESHOLD + 1)
    const result = judgeVerdict(plan('packer::diec'), stdout, 0)
    expect(result.truncated).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Exit-code semantics (R8-2)                                                 */
/* -------------------------------------------------------------------------- */

describe('judgeVerdict — exit-code semantics (R8-2)', () => {
  test('exitCode !== 0 with no pattern match → inconclusive + null', () => {
    const result = judgeVerdict(plan('packer::diec'), 'totally unrelated output', 1)
    expect(result.verdict).toBe('inconclusive')
    expect(result.matchedPattern).toBe(null)
    expect(result.truncated).toBe(false)
  })

  test('exitCode === 0 with no pattern match → inconclusive + null', () => {
    const result = judgeVerdict(plan('packer::diec'), 'totally unrelated output', 0)
    expect(result.verdict).toBe('inconclusive')
    expect(result.matchedPattern).toBe(null)
  })

  test('exitCode !== 0 does NOT flip a confirmed match to inconclusive', () => {
    // upx -t can return non-zero even on tested-ok lines on some
    // builds; the engine must surface the confirms regardless.
    const stdout = readCorpus('packer-upx-tested-ok.txt')
    const result = judgeVerdict(plan('packer::upx-test'), stdout, 2)
    expect(result.verdict).toBe('confirms')
  })

  test('exitCode !== 0 with falsifies match → falsifies (not inconclusive)', () => {
    const stdout = readCorpus('packer-upx-not-packed.txt')
    const result = judgeVerdict(plan('packer::upx-test'), stdout, 1)
    expect(result.verdict).toBe('falsifies')
  })
})

/* -------------------------------------------------------------------------- */
/* PBT — Property 9: referential transparency (R8-7)                          */
/* -------------------------------------------------------------------------- */

/**
 * Property 9: judgeVerdict is referentially transparent — calling it
 * twice with the same arguments returns deeply-equal results, in any
 * order, with no observable side effect.
 *
 * We sample plan ids from the canonical table (so all 6 tools and 8
 * kinds are reachable) and stdout from a string arbitrary that includes
 * regex meta-characters (to flush out any accidental statefulness like
 * a global-flag RegExp `lastIndex` regression).
 *
 * Validates: Requirements 8.7
 */
describe('PBT — Property 9: referential transparency', () => {
  // A representative sample of plan ids spanning all 8 kinds + all 6
  // tools. Sampling instead of every plan keeps the run cheap; the
  // property holds for the whole table by construction (no plan-specific
  // state lives in verdict.ts).
  const samplePlanIds = [
    'file-class::file-cmd',
    'packer::diec',
    'packer::upx-test',
    'compiler::dnspy-probe',
    'compiler::go-probe',
    'family::yara-scan',
    'family::strings-grep',
    'algorithm::strings-crypto-tokens',
    'anti-analysis::strings-grep',
    'capability::imports-table',
    'protocol::strings-protocol-tokens',
  ] as const

  test('two consecutive calls with same args return deeply-equal results', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...samplePlanIds),
        fc.string({ maxLength: 4096 }),
        fc.integer({ min: -1, max: 255 }),
        (planId, stdout, exitCode) => {
          const p = plan(planId)
          const r1 = judgeVerdict(p, stdout, exitCode)
          const r2 = judgeVerdict(p, stdout, exitCode)
          return deepEqualVerdict(r1, r2)
        },
      ),
      { numRuns: 200 },
    )
  })

  test('three consecutive calls with same args return deeply-equal results', () => {
    // Stronger variant: catches stateful bugs where r1 ≠ r2 but
    // r2 === r3 (e.g. RegExp.lastIndex settled after first hit).
    fc.assert(
      fc.property(
        fc.constantFrom(...samplePlanIds),
        fc.string({ maxLength: 4096 }),
        fc.integer({ min: -1, max: 255 }),
        (planId, stdout, exitCode) => {
          const p = plan(planId)
          const r1 = judgeVerdict(p, stdout, exitCode)
          const r2 = judgeVerdict(p, stdout, exitCode)
          const r3 = judgeVerdict(p, stdout, exitCode)
          return (
            deepEqualVerdict(r1, r2) &&
            deepEqualVerdict(r2, r3)
          )
        },
      ),
      { numRuns: 200 },
    )
  })
})

/** Deep-equal helper for {@link VerdictResult}; all fields are scalar. */
function deepEqualVerdict(a: VerdictResult, b: VerdictResult): boolean {
  return (
    a.verdict === b.verdict &&
    a.matchedPattern === b.matchedPattern &&
    a.truncated === b.truncated
  )
}

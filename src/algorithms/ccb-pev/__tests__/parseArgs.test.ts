/**
 * Tests for `parseArgs.ts` (T12) — `/ccb-pev` CLI flag parser.
 *
 * Coverage map:
 *   - Happy: bare path → ok with defaults, goal=null
 *   - Goal: path + free-form goal → goal joined with single spaces
 *   - Flag overrides: --max-rounds + --max-tools applied
 *   - Wallclock conversion: --max-wallclock-min=N → maxWallClockMs=N*60_000
 *   - Empty input → error mentioning Usage
 *   - Out-of-range numeric → error mentioning bound + observed value
 *   - Unknown flag → error mentioning the flag spelling
 *   - Non-integer flag value → rejected
 *   - Mixed positional + flags interleaved → still resolves
 *
 * Validates: Requirements R11-1, R11-2, R11-7, R13-2.
 */

import { describe, expect, test } from 'bun:test'

import { parseArgs } from '../parseArgs.js'

describe('parseArgs — happy path', () => {
  test('bare path resolves to defaults + goal=null', () => {
    const result = parseArgs('e:/payload.exe')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.args.targetBinary).toBe('e:/payload.exe')
    expect(result.args.goal).toBeNull()
    expect(result.args.budget).toEqual({
      maxRounds: 8,
      maxToolCalls: 24,
      maxTokens: 300_000,
      // 30 minutes default → 1_800_000 ms
      maxWallClockMs: 30 * 60 * 1000,
    })
  })

  test('positional goal is joined with single spaces', () => {
    const result = parseArgs('e:/payload.exe   judge   if   packed')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.args.targetBinary).toBe('e:/payload.exe')
    expect(result.args.goal).toBe('judge if packed')
  })

  test('flag overrides apply to the budget', () => {
    const result = parseArgs(
      'e:/payload.exe --max-rounds=4 --max-tools=12',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.args.budget.maxRounds).toBe(4)
    expect(result.args.budget.maxToolCalls).toBe(12)
    // unaffected flags keep their defaults
    expect(result.args.budget.maxTokens).toBe(300_000)
    expect(result.args.budget.maxWallClockMs).toBe(30 * 60 * 1000)
  })

  test('--max-wallclock-min is converted to ms', () => {
    const result = parseArgs('e:/payload.exe --max-wallclock-min=10')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.args.budget.maxWallClockMs).toBe(10 * 60 * 1000)
  })

  test('--max-tokens applies a custom token cap', () => {
    const result = parseArgs('e:/p.exe --max-tokens=50000')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.args.budget.maxTokens).toBe(50_000)
  })

  test('mixed positional + flags interleaved still resolves', () => {
    const result = parseArgs(
      '--max-rounds=4 e:/path.exe --max-tools=8 the goal',
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.args.targetBinary).toBe('e:/path.exe')
    expect(result.args.goal).toBe('the goal')
    expect(result.args.budget.maxRounds).toBe(4)
    expect(result.args.budget.maxToolCalls).toBe(8)
  })
})

describe('parseArgs — error paths', () => {
  test('empty string returns Usage error', () => {
    const result = parseArgs('')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Usage:')
    expect(result.error).toContain('/ccb-pev')
  })

  test('whitespace-only also returns Usage error', () => {
    const result = parseArgs('   \t  ')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Usage:')
  })

  test('flags-only without a binary path returns Usage error', () => {
    const result = parseArgs('--max-rounds=4 --max-tools=8')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('Usage:')
  })

  test('--max-rounds=99 is out of range', () => {
    const result = parseArgs('e:/p.exe --max-rounds=99')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('--max-rounds')
    expect(result.error).toContain('[1, 16]')
    expect(result.error).toContain('99')
  })

  test('--max-tools=0 is out of range (lower bound)', () => {
    const result = parseArgs('e:/p.exe --max-tools=0')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('--max-tools')
    expect(result.error).toContain('[1, 64]')
  })

  test('--max-tokens below minimum is rejected', () => {
    const result = parseArgs('e:/p.exe --max-tokens=500')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('--max-tokens')
  })

  test('--max-wallclock-min above ceiling is rejected', () => {
    const result = parseArgs('e:/p.exe --max-wallclock-min=999')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('--max-wallclock-min')
    expect(result.error).toContain('[1, 240]')
  })

  test('unknown flag --xyz=1 is rejected with flag name', () => {
    const result = parseArgs('e:/p.exe --xyz=1')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('--xyz')
  })

  test('flag without `=` separator is rejected', () => {
    const result = parseArgs('e:/p.exe --max-rounds 4')
    expect(result.ok).toBe(false)
    if (result.ok) return
    // Either the `--max-rounds` flag fails the "no = found" check or
    // the trailing positional `4` makes it look unparseable. We just
    // need a non-OK result with an informative message.
    expect(result.error.length).toBeGreaterThan(0)
  })

  test('non-integer flag value is rejected', () => {
    const result = parseArgs('e:/p.exe --max-rounds=4.5')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('--max-rounds')
    expect(result.error).toContain('integer')
  })
})

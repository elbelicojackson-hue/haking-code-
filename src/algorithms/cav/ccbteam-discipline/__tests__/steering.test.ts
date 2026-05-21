/**
 * T19 — steering file existence + structure tests.
 *
 * Covers:
 *   - File exists at the project-level steering path
 *   - frontmatter contains `inclusion: always`
 *   - `## Invocation Gate` section has exactly 5 `[gate-*]` bullets
 *   - `## Anti-Patterns` section has ≥ 6 bullets
 *   - File contains zero Math Layer keywords (R5-9 / R12-6)
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const STEERING_PATH = resolve(
  process.cwd(),
  '.kiro',
  'steering',
  'ccbteam-invocation-discipline.md',
)

const MATH_KEYWORD_RE = /(cr-?eig|exploitability|epsilon[-_]?n(?:ash)?e?|\brho_t\b|rankgradient|crEig)/i

describe('steering: ccbteam-invocation-discipline.md', () => {
  it('file exists at the project-level path', () => {
    expect(existsSync(STEERING_PATH)).toBe(true)
  })

  it('frontmatter declares inclusion: always', () => {
    const text = readFileSync(STEERING_PATH, 'utf8').replace(/\r\n/g, '\n')
    expect(text.startsWith('---\n')).toBe(true)
    const fmEnd = text.indexOf('\n---', 4)
    expect(fmEnd).toBeGreaterThan(0)
    const fm = text.slice(4, fmEnd)
    expect(fm).toContain('inclusion: always')
  })

  it('## Invocation Gate section has exactly 5 [gate-*] bullets', () => {
    const text = readFileSync(STEERING_PATH, 'utf8').replace(/\r\n/g, '\n')
    const gateIdx = text.indexOf('## Invocation Gate')
    expect(gateIdx).toBeGreaterThan(0)
    const tail = text.slice(gateIdx)
    const matches = tail.match(/^- \[gate-[a-z-]+\]/gm) ?? []
    expect(matches.length).toBe(5)
  })

  it('## Anti-Patterns section has ≥ 6 bullets', () => {
    const text = readFileSync(STEERING_PATH, 'utf8').replace(/\r\n/g, '\n')
    const antiIdx = text.indexOf('## Anti-Patterns')
    expect(antiIdx).toBeGreaterThan(0)
    const tail = text.slice(antiIdx)
    const nextHeadIdx = tail.search(/\n## /)
    const block = nextHeadIdx > 0 ? tail.slice(0, nextHeadIdx) : tail
    const bullets = block.match(/^- /gm) ?? []
    expect(bullets.length).toBeGreaterThanOrEqual(6)
  })

  it('contains zero Math Layer keywords (R12-6 / R5-9)', () => {
    const text = readFileSync(STEERING_PATH, 'utf8').replace(/\r\n/g, '\n')
    expect(MATH_KEYWORD_RE.test(text)).toBe(false)
  })
})

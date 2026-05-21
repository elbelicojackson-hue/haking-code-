/**
 * T14 — Pure Observer Contract static-scan guards.
 *
 * The two scanners enforce R5-3 / R5-8 and R5-9:
 *
 *   1. **Import scan**: command-layer files (`src/commands/ccbteam/**`)
 *      MUST NOT import any `services/cav/ccbteam-math/**` module
 *      EXCEPT the whitelisted entries (`sidecar`, `auditLog`,
 *      `constants`, `types`).
 *
 *   2. **Prompt-content scan**: rendered output of `buildCcbTeamPrompt`
 *      under any input MUST NOT contain Math Layer keywords (`cr-eig`,
 *      `exploitability`, `epsilon`/`epsilon-nash`, `rankgradient`).
 *
 * The scanners self-test via constructed positive/negative samples
 * (R11-3 mandate). Failures print exact source-path + line for
 * actionable diagnostics.
 */

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { buildCcbTeamPrompt } from '../../../../commands/ccbteam/buildPrompt.js'
import { resolveProfile } from '../../../../commands/ccbteam/profiles/index.js'
import { applyInvocationGate } from '../../ccbteam-discipline/invocationGate.js'
import { buildEpistemicHonestyBlock } from '../../ccbteam-discipline/epistemicBlock.js'

/* -------------------------------------------------------------------------- */
/* import scanner                                                             */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = process.cwd()

/**
 * Math-layer modules that the command layer MUST NOT import directly.
 * `sidecar`, `auditLog`, `constants`, `types` are whitelisted boundary
 * entries (design.md → "Component 5 / R5-3 边界处理").
 */
const FORBIDDEN_MATH_MODULES = [
  'crEig',
  'delta',
  'urgency',
  'exploitability',
  'utility',
  'cost',
  'rankGradients',
]

const WHITELIST = new Set(['sidecar', 'auditLog', 'constants', 'types'])

const COMMAND_LAYER_ROOT = join(REPO_ROOT, 'src', 'commands', 'ccbteam')

function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      // Skip the test directory — its tests are *allowed* to import
      // math layer modules for verification purposes.
      if (entry === '__tests__') continue
      yield* walkTsFiles(full)
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      yield full
    }
  }
}

const IMPORT_RE = /(?:from\s+['"])([^'"]+)(?:['"])/g

type ImportViolation = {
  readonly file: string
  readonly line: number
  readonly importPath: string
}

function scanForbiddenImports(): ImportViolation[] {
  const violations: ImportViolation[] = []
  for (const file of walkTsFiles(COMMAND_LAYER_ROOT)) {
    const text = readFileSync(file, 'utf8')
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      // Only consider lines that look like ESM imports
      if (!/^\s*import\b/.test(line) && !line.includes('require(')) continue
      const match = IMPORT_RE.exec(line)
      IMPORT_RE.lastIndex = 0
      const importPath = match?.[1] ?? null
      if (!importPath) continue
      if (!importPath.includes('ccbteam-math')) continue
      // Extract module name = last path segment without extension.
      const moduleName = importPath
        .replace(/\.js$/, '')
        .replace(/\.ts$/, '')
        .split('/')
        .pop()
      if (!moduleName) continue
      if (WHITELIST.has(moduleName)) continue
      if (FORBIDDEN_MATH_MODULES.includes(moduleName)) {
        violations.push({
          file: file.replace(REPO_ROOT + sep, ''),
          line: i + 1,
          importPath,
        })
      }
    }
  }
  return violations
}

describe('T14 — Pure Observer import scanner', () => {
  it('self-test: scanner detects a contrived violation in a synthetic file', () => {
    const synthetic = `
      import { computeCrEig } from '../../services/cav/ccbteam-math/crEig.js'
    `
    expect(synthetic.includes('crEig')).toBe(true)
    // Run the same regex used by the scanner
    let m: RegExpExecArray | null
    let foundForbidden = false
    while ((m = IMPORT_RE.exec(synthetic))) {
      const segs = m[1]!.split('/')
      const mod = segs[segs.length - 1]!.replace(/\.(js|ts)$/, '')
      if (FORBIDDEN_MATH_MODULES.includes(mod)) foundForbidden = true
    }
    IMPORT_RE.lastIndex = 0
    expect(foundForbidden).toBe(true)
  })

  it('self-test: scanner allows whitelisted boundary imports', () => {
    const synthetic = `
      import { startSidecar } from '../../services/cav/ccbteam-math/sidecar.js'
      import { openAuditWriter } from '../../services/cav/ccbteam-math/auditLog.js'
      import { DEFAULT_CR_EIG_WEIGHTS } from '../../services/cav/ccbteam-math/constants.js'
    `
    let foundForbidden = false
    let m: RegExpExecArray | null
    while ((m = IMPORT_RE.exec(synthetic))) {
      const segs = m[1]!.split('/')
      const mod = segs[segs.length - 1]!.replace(/\.(js|ts)$/, '')
      if (FORBIDDEN_MATH_MODULES.includes(mod)) foundForbidden = true
    }
    IMPORT_RE.lastIndex = 0
    expect(foundForbidden).toBe(false)
  })

  it('command layer (src/commands/ccbteam/**) has zero forbidden imports', () => {
    const violations = scanForbiddenImports()
    if (violations.length > 0) {
      // Surface every violation with file:line so the diff is obvious
      const summary = violations
        .map(v => `${v.file}:${v.line} → ${v.importPath}`)
        .join('\n')
      throw new Error(
        `Pure Observer R5-3 violation detected — command layer imports forbidden Math Layer modules:\n${summary}`,
      )
    }
    expect(violations.length).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* prompt-content scanner                                                     */
/* -------------------------------------------------------------------------- */

const MATH_KEYWORD_RE =
  /(cr-?eig|exploitability|epsilon[-_]?n(?:ash)?e?|\brho_t\b|rankgradient|crEig)/i

describe('T14 — Pure Observer prompt-content scanner', () => {
  it('self-test: scanner catches a leaked "cr-eig" keyword', () => {
    const sample = 'this prompt mentions CR-EIG which it should not'
    expect(MATH_KEYWORD_RE.test(sample)).toBe(true)
  })

  it('buildCcbTeamPrompt single-arg → no Math Layer keywords (50 PBT inputs)', () => {
    let s = 0xc0bba >>> 0
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 2 ** 32
    }
    for (let i = 0; i < 50; i++) {
      const claim = `claim-${rnd().toString(36).slice(2, 12)}`
      const r = resolveProfile(claim)
      const text = buildCcbTeamPrompt(r)
      if (MATH_KEYWORD_RE.test(text)) {
        throw new Error(
          `Pure Observer R5-9 violation — buildCcbTeamPrompt leaked Math Layer keyword for claim="${claim}"`,
        )
      }
    }
    expect(true).toBe(true)
  })

  it('buildCcbTeamPrompt with epistemicHonestyBlock → no Math keywords (R13)', () => {
    const r = resolveProfile('test claim')
    const text = buildCcbTeamPrompt(r, {
      epistemicHonestyBlock: buildEpistemicHonestyBlock(),
    })
    expect(MATH_KEYWORD_RE.test(text)).toBe(false)
  })

  it('applyInvocationGate(HELP_REPLY) → no Math keywords (R12-6)', () => {
    const text = applyInvocationGate('HELP_REPLY_PLACEHOLDER')
    expect(MATH_KEYWORD_RE.test(text)).toBe(false)
  })

  it('buildEpistemicHonestyBlock → no Math keywords (R13)', () => {
    expect(MATH_KEYWORD_RE.test(buildEpistemicHonestyBlock())).toBe(false)
  })
})

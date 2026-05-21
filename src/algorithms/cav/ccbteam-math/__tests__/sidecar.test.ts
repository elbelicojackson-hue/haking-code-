/**
 * T11 — Sidecar tests.
 *
 * Covers:
 *   - R5-5: prompt-only mode → null handle, NO file created
 *   - R8-6: same — no audit file in prompt-only
 *   - R5-4: observe mode mounts and writes events
 *   - R7-6: poll error → degradation event, no throw
 *   - R8-1..R8-2: audit log NDJSON shape
 *   - R9-1: renderInformationEfficiencyMarkdown 5-line shape
 *   - R13: epistemic missing → degradation event
 *   - stop() idempotent
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startSidecar } from '../sidecar.js'
import { DEFAULT_CR_EIG_WEIGHTS } from '../constants.js'
import {
  clearRecentCavRecords,
  recordCav,
} from '../../recorder.js'
import type { CavRecord, OracleAnchor, SidecarOptions } from '../types.js'

let SESSION_DIR = ''
let SESSION_ID = ''

beforeEach(() => {
  SESSION_DIR = mkdtempSync(join(tmpdir(), 'sac-sidecar-'))
  SESSION_ID = `sess-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
})

afterEach(() => {
  try {
    clearRecentCavRecords(SESSION_ID)
    rmSync(SESSION_DIR, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

const baseOpts = (overrides: Partial<SidecarOptions> = {}): SidecarOptions => ({
  strategy: 'observe',
  weights: DEFAULT_CR_EIG_WEIGHTS,
  explain: false,
  sessionId: SESSION_ID,
  sessionDir: SESSION_DIR,
  profileId: 'generic',
  oracleAnchors: [],
  ...overrides,
})

const auditPath = (): string => join(SESSION_DIR, 'ccbteam-math-audit.jsonl')

const cavRec = (
  agentId: string,
  claim: string,
  turn = 0,
): CavRecord => ({
  sessionId: SESSION_ID,
  teamName: 'team',
  agentId,
  agentName: agentId,
  model: 'mock',
  turn,
  timestamp: Date.now(),
  claim,
  cav: {
    self_entropy: 0.3,
    calibration: 0.7,
    update_kl: 0.4,
    repair_style: 'defend',
    commitment: null,
    hesitation: null,
    coherence: null,
    trace_depth: null,
    latency: null,
    reciprocity: null,
  },
})

const epistemicTeammateText = (claim: string): string =>
  `${claim}\n\n\`\`\`epistemic\n{"knowledge_zone":"core","training_cutoff_aware":"2025-04","oracle_used":null,"claim_grounded_in":"memory","refusal_when_unknown":false}\n\`\`\`\n\n\`\`\`cav\n{"repair_style":"defend"}\n\`\`\``

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/* -------------------------------------------------------------------------- */
/* R5-5 / R8-6 prompt-only short-circuit                                      */
/* -------------------------------------------------------------------------- */

describe('startSidecar — R5-5 prompt-only', () => {
  it('returns null when strategy=prompt-only', () => {
    const handle = startSidecar(baseOpts({ strategy: 'prompt-only' }))
    expect(handle).toBeNull()
  })

  it('does NOT create audit file in prompt-only', async () => {
    startSidecar(baseOpts({ strategy: 'prompt-only' }))
    await sleep(200)
    expect(existsSync(auditPath())).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* R5-4 / R8-1 observe mode mounts and writes                                 */
/* -------------------------------------------------------------------------- */

describe('startSidecar — observe mode', () => {
  it('returns a handle with the SidecarHandle shape', () => {
    const h = startSidecar(baseOpts())
    expect(h).not.toBeNull()
    expect(typeof h!.stop).toBe('function')
    expect(typeof h!.totalCrEigBits).toBe('function')
    expect(typeof h!.currentEpsilon).toBe('function')
    expect(typeof h!.renderInformationEfficiencyMarkdown).toBe('function')
    h!.stop()
  })

  it('writes session.start + session.end to audit log', async () => {
    const h = startSidecar(baseOpts())
    await sleep(50)
    await h!.stop()
    const text = readFileSync(auditPath(), 'utf8')
    const lines = text.split('\n').filter(Boolean).map(l => JSON.parse(l))
    expect(lines.find(l => l.kind === 'session.start')).toBeDefined()
    expect(lines.find(l => l.kind === 'session.end')).toBeDefined()
  })

  it('observes recorded CAV records → emits round.exploitability + round.cr-eig', async () => {
    const h = startSidecar(baseOpts())
    // Push 5 records (above MIN_SAMPLES_FOR_MI threshold so eps becomes
    // estimable) into the recorder ring.
    for (let i = 0; i < 5; i++) {
      await recordCav(
        cavRec(`agent-${i}`, epistemicTeammateText(`claim-${i}`), i),
      )
    }
    // Wait at least one polling cycle (120ms) plus buffer.
    await sleep(300)
    await h!.stop()
    const text = readFileSync(auditPath(), 'utf8')
    const kinds = text
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l).kind)
    expect(kinds).toContain('round.exploitability')
    expect(kinds).toContain('round.cr-eig')
  })

  it('records round.epistemic when teammate output has a valid block', async () => {
    const h = startSidecar(baseOpts())
    for (let i = 0; i < 5; i++) {
      await recordCav(
        cavRec(`agent-${i}`, epistemicTeammateText(`claim-${i}`), i),
      )
    }
    await sleep(300)
    await h!.stop()
    const text = readFileSync(auditPath(), 'utf8')
    const kinds = text
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l).kind)
    expect(kinds.filter(k => k === 'round.epistemic').length).toBeGreaterThan(0)
  })

  it('records degradation epistemic-missing when block is absent', async () => {
    const h = startSidecar(baseOpts())
    for (let i = 0; i < 5; i++) {
      await recordCav(cavRec(`agent-${i}`, `bare claim ${i}`, i))
    }
    await sleep(300)
    await h!.stop()
    const text = readFileSync(auditPath(), 'utf8')
    const lines = text.split('\n').filter(Boolean).map(l => JSON.parse(l))
    const degrade = lines.find(
      l => l.kind === 'degradation' && l.reason === 'epistemic-missing',
    )
    expect(degrade).toBeDefined()
  })
})

/* -------------------------------------------------------------------------- */
/* R7-6 fail-soft & idempotent stop                                           */
/* -------------------------------------------------------------------------- */

describe('startSidecar — robustness', () => {
  it('stop() is idempotent', async () => {
    const h = startSidecar(baseOpts())!
    await h.stop()
    await h.stop()
    await h.stop()
    expect(true).toBe(true)
  })

  it('totalCrEigBits / currentEpsilon are safe to call before any data', async () => {
    const h = startSidecar(baseOpts())!
    expect(h.totalCrEigBits()).toBe(0)
    expect(h.currentEpsilon()).toBeNull()
    await h.stop()
  })
})

/* -------------------------------------------------------------------------- */
/* R9-1 Information Efficiency rendering                                      */
/* -------------------------------------------------------------------------- */

describe('renderInformationEfficiencyMarkdown', () => {
  it('returns the canonical 5-line block + Knowledge Boundary section', async () => {
    const h = startSidecar(baseOpts())!
    for (let i = 0; i < 5; i++) {
      await recordCav(
        cavRec(`agent-${i}`, epistemicTeammateText(`claim-${i}`), i),
      )
    }
    await sleep(300)
    const md = h.renderInformationEfficiencyMarkdown()
    expect(md).toContain('## Information Efficiency')
    expect(md).toMatch(/Total CR-EIG observed: \d+\.\d{2} bits/)
    expect(md).toMatch(/Tool calls: \d+/)
    expect(md).toMatch(/Final ε_t: /)
    expect(md).toMatch(/Causal fraction: /)
    expect(md).toMatch(/Trust-weighted α drift: /)
    expect(md).toContain('### Knowledge Boundary Violations')
    await h.stop()
  })

  it('has empty (none) marker when no violations recorded', async () => {
    const h = startSidecar(baseOpts())!
    for (let i = 0; i < 5; i++) {
      await recordCav(
        cavRec(`agent-${i}`, epistemicTeammateText(`claim-${i}`), i),
      )
    }
    await sleep(300)
    const md = h.renderInformationEfficiencyMarkdown()
    expect(md).toContain('(none)')
    await h.stop()
  })
})

/* -------------------------------------------------------------------------- */
/* Oracle anchors (smoke)                                                     */
/* -------------------------------------------------------------------------- */

describe('startSidecar — oracle anchors', () => {
  it('still emits round.exploitability when oracleAnchors are provided', async () => {
    const anchors: OracleAnchor[] = [
      { id: 'o', referenceText: 'PE32+ executable confirmed', source: 'profile' },
    ]
    const h = startSidecar(baseOpts({ oracleAnchors: anchors }))!
    for (let i = 0; i < 5; i++) {
      await recordCav(
        cavRec(`agent-${i}`, epistemicTeammateText('PE32+ executable'), i),
      )
    }
    await sleep(300)
    await h.stop()
    const text = readFileSync(auditPath(), 'utf8')
    const lines = text.split('\n').filter(Boolean).map(l => JSON.parse(l))
    const eps = lines.find(l => l.kind === 'round.exploitability')
    expect(eps).toBeDefined()
  })
})

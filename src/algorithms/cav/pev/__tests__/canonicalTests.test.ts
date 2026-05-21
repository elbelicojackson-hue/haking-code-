/**
 * Canonical Test Plans — table completeness + invariant tests.
 *
 * Coverage map (per task T5 DoD + Property 4):
 *   - Table size floor (≥ 24 entries; spec asserts at least 24).
 *   - Plan id lexical shape (`^[a-z-]+::[a-z0-9-]+$`).
 *   - Plan id prefix === plan.kind (no off-by-one).
 *   - Every {@link HypothesisKind} has ≥ 3 plans (spec hint requires it
 *     for routing redundancy).
 *   - Every plan.tool is in {@link TOOL_ALLOWLIST}.
 *   - timeout_ms ∈ [1000, 1_800_000] (R4-9).
 *   - confirms / falsifies are arrays of RegExp (may be empty).
 *   - findToolPlan: hit + miss.
 *   - getToolPlansForKind: returns ≥ 3 plans, all matching kind.
 *   - ALL_TOOL_PLAN_IDS membership.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 14.4
 */

import { describe, expect, test } from 'bun:test'
import {
  ALL_TOOL_PLAN_IDS,
  CANONICAL_TESTS,
  TOOL_ALLOWLIST,
  type ToolPlan,
  findToolPlan,
  getToolPlansForKind,
} from '../canonicalTests.js'
import type { HypothesisKind } from '../protocol.js'

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const ALL_KINDS: readonly HypothesisKind[] = [
  'file-class',
  'packer',
  'compiler',
  'family',
  'algorithm',
  'anti-analysis',
  'capability',
  'protocol',
] as const

const PLAN_ID_REGEX = /^[a-z-]+::[a-z0-9-]+$/

/* -------------------------------------------------------------------------- */
/* Property 4 — table completeness invariants                                 */
/* -------------------------------------------------------------------------- */

describe('CANONICAL_TESTS table — Property 4 invariants', () => {
  const allPlans = Object.values(CANONICAL_TESTS) as ToolPlan[]

  test('has at least 24 plans (8 kinds × ≥ 3 plans each)', () => {
    expect(allPlans.length).toBeGreaterThanOrEqual(24)
  })

  test('every plan id matches /^[a-z-]+::[a-z0-9-]+$/', () => {
    for (const plan of allPlans) {
      expect(plan.id).toMatch(PLAN_ID_REGEX)
    }
  })

  test('every plan key in CANONICAL_TESTS equals plan.id', () => {
    for (const [key, plan] of Object.entries(CANONICAL_TESTS)) {
      expect(plan.id).toBe(key)
    }
  })

  test('plan id prefix matches plan.kind', () => {
    for (const plan of allPlans) {
      const prefix = plan.id.split('::', 1)[0]
      expect(prefix).toBe(plan.kind)
    }
  })

  test('every HypothesisKind has at least 1 plan', () => {
    const kindsSeen = new Set<HypothesisKind>(allPlans.map(p => p.kind))
    for (const kind of ALL_KINDS) {
      expect(kindsSeen.has(kind)).toBe(true)
    }
  })

  test('every HypothesisKind has at least 3 plans (spec hint)', () => {
    for (const kind of ALL_KINDS) {
      const forKind = allPlans.filter(p => p.kind === kind)
      expect(forKind.length).toBeGreaterThanOrEqual(3)
    }
  })

  test('every plan.tool is in TOOL_ALLOWLIST', () => {
    const allow = new Set<string>(TOOL_ALLOWLIST)
    for (const plan of allPlans) {
      expect(allow.has(plan.tool)).toBe(true)
    }
  })

  test('TOOL_ALLOWLIST contains exactly the 6 fixed entries', () => {
    expect([...TOOL_ALLOWLIST].sort()).toEqual(
      ['Bash', 'Firecrawl', 'Grep', 'Read', 'ReverseCli', 'WebSearch'].sort(),
    )
  })

  test('every plan.timeout_ms is in [1000, 1_800_000]', () => {
    for (const plan of allPlans) {
      expect(plan.timeout_ms).toBeGreaterThanOrEqual(1000)
      expect(plan.timeout_ms).toBeLessThanOrEqual(1_800_000)
    }
  })

  test('every plan.confirms is an array of RegExp', () => {
    for (const plan of allPlans) {
      expect(Array.isArray(plan.confirms)).toBe(true)
      for (const re of plan.confirms) {
        expect(re).toBeInstanceOf(RegExp)
      }
    }
  })

  test('every plan.falsifies is an array of RegExp', () => {
    for (const plan of allPlans) {
      expect(Array.isArray(plan.falsifies)).toBe(true)
      for (const re of plan.falsifies) {
        expect(re).toBeInstanceOf(RegExp)
      }
    }
  })

  test('every plan.overridable_fields is a string array', () => {
    for (const plan of allPlans) {
      expect(Array.isArray(plan.overridable_fields)).toBe(true)
      for (const field of plan.overridable_fields) {
        expect(typeof field).toBe('string')
      }
    }
  })

  test('every plan.cost_estimate is a known bucket', () => {
    const buckets = new Set(['tiny', 'small', 'medium', 'large'])
    for (const plan of allPlans) {
      expect(buckets.has(plan.cost_estimate)).toBe(true)
    }
  })

  test('every plan.description is a non-empty string', () => {
    for (const plan of allPlans) {
      expect(typeof plan.description).toBe('string')
      expect(plan.description.length).toBeGreaterThan(0)
    }
  })

  test('plan ids are unique (no duplicate keys after declaration)', () => {
    const ids = allPlans.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

/* -------------------------------------------------------------------------- */
/* Helpers — getToolPlansForKind, findToolPlan, ALL_TOOL_PLAN_IDS             */
/* -------------------------------------------------------------------------- */

describe('getToolPlansForKind', () => {
  test('returns ≥ 3 plans for "packer", all with kind="packer"', () => {
    const plans = getToolPlansForKind('packer')
    expect(plans.length).toBeGreaterThanOrEqual(3)
    for (const p of plans) {
      expect(p.kind).toBe('packer')
    }
  })

  test('returns at least one plan for every HypothesisKind', () => {
    for (const kind of ALL_KINDS) {
      const plans = getToolPlansForKind(kind)
      expect(plans.length).toBeGreaterThanOrEqual(1)
      for (const p of plans) {
        expect(p.kind).toBe(kind)
      }
    }
  })

  test('packer plans include the canonical packer::diec entry', () => {
    const plans = getToolPlansForKind('packer')
    expect(plans.some(p => p.id === 'packer::diec')).toBe(true)
  })
})

describe('findToolPlan', () => {
  test('returns the plan when id is known', () => {
    const plan = findToolPlan('packer::diec')
    expect(plan).toBeDefined()
    expect(plan?.id).toBe('packer::diec')
    expect(plan?.kind).toBe('packer')
  })

  test('returns undefined when id is unknown', () => {
    expect(findToolPlan('does::not-exist')).toBeUndefined()
  })

  test('returns undefined for the empty string', () => {
    expect(findToolPlan('')).toBeUndefined()
  })

  test('returns undefined for inherited Object prototype keys', () => {
    // Defence-in-depth: hasOwnProperty guard prevents prototype pollution.
    expect(findToolPlan('toString')).toBeUndefined()
    expect(findToolPlan('__proto__')).toBeUndefined()
  })
})

describe('ALL_TOOL_PLAN_IDS', () => {
  test('contains every key from CANONICAL_TESTS', () => {
    for (const id of Object.keys(CANONICAL_TESTS)) {
      expect(ALL_TOOL_PLAN_IDS.has(id)).toBe(true)
    }
  })

  test('size equals number of plans', () => {
    expect(ALL_TOOL_PLAN_IDS.size).toBe(Object.keys(CANONICAL_TESTS).length)
  })

  test('does not contain unknown ids', () => {
    expect(ALL_TOOL_PLAN_IDS.has('packer::xxxxxxx')).toBe(false)
    expect(ALL_TOOL_PLAN_IDS.has('does::not-exist')).toBe(false)
  })

  test('contains the canonical packer::diec id (smoke)', () => {
    expect(ALL_TOOL_PLAN_IDS.has('packer::diec')).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Spot-checks on representative plans (sanity, not exhaustive)               */
/* -------------------------------------------------------------------------- */

describe('representative plan content', () => {
  test('packer::diec confirms include UPX/VMProtect and use ReverseCli', () => {
    const plan = findToolPlan('packer::diec')
    expect(plan).toBeDefined()
    if (!plan) return
    expect(plan.tool).toBe('ReverseCli')
    expect(plan.confirms.some(re => re.test('Packer: UPX(4.0)[NRV,brute]'))).toBe(true)
    expect(plan.confirms.some(re => re.test('Protector: VMProtect'))).toBe(true)
  })

  test('packer::upx-test confirms tested-ok and falsifies on not-packed', () => {
    const plan = findToolPlan('packer::upx-test')
    expect(plan).toBeDefined()
    if (!plan) return
    expect(plan.confirms.some(re => re.test('upx 4.0 - tested ok'))).toBe(true)
    expect(
      plan.falsifies.some(re => re.test('not packed by upx (notpackedexception)')),
    ).toBe(true)
  })

  test('compiler::dnspy-probe confirms Mono/.Net assembly via libmagic', () => {
    const plan = findToolPlan('compiler::dnspy-probe')
    expect(plan).toBeDefined()
    if (!plan) return
    expect(plan.tool).toBe('Bash')
    expect(
      plan.confirms.some(re =>
        re.test('PE32 executable (console) Intel 80386 Mono/.Net assembly'),
      ),
    ).toBe(true)
  })

  test('file-class::file-cmd confirms PE/ELF/Mach-O containers', () => {
    const plan = findToolPlan('file-class::file-cmd')
    expect(plan).toBeDefined()
    if (!plan) return
    expect(plan.confirms.some(re => re.test('PE32+ executable (console) x86-64'))).toBe(true)
    expect(plan.confirms.some(re => re.test('ELF 64-bit LSB shared object'))).toBe(true)
    expect(plan.confirms.some(re => re.test('Mach-O 64-bit executable'))).toBe(true)
  })
})

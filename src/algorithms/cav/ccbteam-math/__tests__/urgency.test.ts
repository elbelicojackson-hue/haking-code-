/**
 * T6 — consensusUrgency tests.
 *
 * Covers:
 *   - R3-3: rho = 1 − eps/EPS_MAX
 *   - R3-5: state matches analyzer.classifyConsensus bit-for-bit
 *   - R3-6: empty records → { rho: 0, state: 'NONE' }
 *   - R3-7: 1000 records perf budget
 *   - PBT 50 fixtures: rho ∈ [0, 1], rho + eps == 1 (with EPS_MAX=1)
 */

import { describe, expect, it } from 'bun:test'
import { classifyConsensus } from '../../analyzer.js'
import { EPS_MAX } from '../constants.js'
import { consensusUrgency } from '../urgency.js'
import type { CavRecord, OracleAnchor, RepairStyle } from '../types.js'

const rec = (
  agentId: string,
  claim: string,
  style: RepairStyle = 'defend',
  turn = 0,
): CavRecord => ({
  sessionId: 'test',
  teamName: 'team',
  agentId,
  agentName: agentId,
  model: 'mock',
  turn,
  timestamp: 0,
  claim,
  cav: {
    self_entropy: 0.3,
    calibration: 0.7,
    update_kl: 0.4,
    repair_style: style,
    commitment: null,
    hesitation: null,
    coherence: null,
    trace_depth: null,
    latency: null,
    reciprocity: null,
  },
})

const anchor = (id: string, text: string): OracleAnchor => ({
  id,
  referenceText: text,
  source: 'profile',
})

describe('consensusUrgency — basic shape', () => {
  it('empty records → { rho: 0, state: NONE } (R3-6)', () => {
    const r = consensusUrgency([], [])
    expect(r.rho).toBe(0)
    expect(r.state).toBe('NONE')
    expect(r.eps).toBe(EPS_MAX)
    expect(r.components.miSampleSufficient).toBe(false)
    expect(r.components.oracleAvailable).toBe(false)
  })

  it('rho + eps === 1 exactly when EPS_MAX = 1', () => {
    const records = [
      rec('A', 'PE32+ exec', 'defend', 0),
      rec('B', 'PE32+ exec', 'defend', 0),
      rec('C', 'PE32+ exec', 'defend', 0),
      rec('D', 'PE32+ exec', 'defend', 0),
      rec('E', 'PE32+ exec', 'defend', 0),
    ]
    const r = consensusUrgency(records, [anchor('o', 'PE32+ exec ground truth')])
    expect(Math.abs(r.rho + r.eps - 1)).toBeLessThan(1e-9)
  })

  it('miSampleSufficient flag matches records.length ≥ 5', () => {
    const fewRecords = [rec('A', 'a'), rec('B', 'b')]
    const r1 = consensusUrgency(fewRecords, [anchor('o', 'baseline')])
    expect(r1.components.miSampleSufficient).toBe(false)

    const manyRecords = [
      rec('A', 'a'),
      rec('B', 'b'),
      rec('C', 'c'),
      rec('D', 'd'),
      rec('E', 'e'),
    ]
    const r2 = consensusUrgency(manyRecords, [])
    expect(r2.components.miSampleSufficient).toBe(true)
  })
})

describe('consensusUrgency — R3-5 state passthrough', () => {
  it('state matches analyzer.classifyConsensus bit-for-bit', () => {
    const cases: CavRecord[][] = [
      [],
      [rec('A', 'foo')],
      [rec('A', 'foo'), rec('B', 'bar')],
      [
        rec('A', 'consensus claim', 'defend', 0),
        rec('B', 'consensus claim', 'concede', 0),
        rec('C', 'consensus claim', 'concede', 0),
      ],
    ]
    for (const records of cases) {
      const ours = consensusUrgency(records, [])
      const theirs = classifyConsensus(records)
      expect(ours.state).toBe(theirs)
    }
  })
})

describe('consensusUrgency — PBT 50 fixtures', () => {
  it('rho always in [0, 1]', () => {
    let s = 0xfeedbeef >>> 0
    const rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0
      return s / 2 ** 32
    }
    for (let i = 0; i < 50; i++) {
      const records: CavRecord[] = []
      const n = 5 + Math.floor(rnd() * 10)
      for (let j = 0; j < n; j++) {
        records.push(
          rec(`A${j % 4}`, `text-${j}`, 'defend', j),
        )
      }
      const anchors =
        rnd() < 0.5
          ? []
          : [anchor('o', `anchor-${rnd().toString(36).slice(2, 6)}`)]
      const r = consensusUrgency(records, anchors)
      expect(r.rho).toBeGreaterThanOrEqual(0)
      expect(r.rho).toBeLessThanOrEqual(1)
    }
  })
})

describe('consensusUrgency — performance', () => {
  it('1000 records ≤ 50ms', () => {
    const records: CavRecord[] = []
    for (let i = 0; i < 1000; i++) {
      records.push(rec(`A${i % 8}`, `claim-${i}`, 'defend', i))
    }
    const t0 = performance.now()
    consensusUrgency(records, [])
    const dt = performance.now() - t0
    expect(dt).toBeLessThan(50)
  })
})

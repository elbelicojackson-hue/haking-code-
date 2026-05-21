/**
 * HypothesisTreeView — pure functional Ink component that renders the
 * PEV hypothesis ledger as a layered tree.
 *
 * Layout convention (per design.md Component 11):
 *   - Roots are entries with no `parentId` (or whose parentId is not in
 *     the map).
 *   - Siblings are sorted by hierarchical-numeric id (`H1 < H1.2 <
 *     H1.10 < H2 < H10`) — lexical sort would scramble depth-2 ids.
 *   - Each node renders one line with 2-space-per-depth indent plus a
 *     status-coloured glyph.
 *   - The view caps total rows at `maxRows` (default 20). Overflow is
 *     surfaced as a `… (+N more)` line at the end so the agent / user
 *     knows there's hidden state.
 *
 * This component is pure — no useState, no useEffect, no I/O. The
 * stateful runner (`PevSession.tsx`) re-renders it on every
 * `ledger-update` event with a fresh snapshot.
 *
 * Cross-references:
 *   - .kiro/specs/ccb-pev-re-execution-loop/design.md → Component 11
 *   - .kiro/specs/ccb-pev-re-execution-loop/requirements.md → R11-4
 */

import { Box, Text } from '@anthropic/ink'

import type {
  Hypothesis,
  HypothesisStatus,
} from '../cav/pev/ledger.js'

type Props = {
  /** Live snapshot from the ledger. */
  readonly hypotheses: ReadonlyMap<string, Hypothesis>
  /**
   * Cap on rendered rows. Default 20 — keeps the panel from blowing
   * past the typical terminal height even when an agent goes into a
   * hypothesis-spawn frenzy.
   */
  readonly maxRows?: number
}

const DEFAULT_MAX_ROWS = 20

/**
 * Status → (glyph, ink color name). The color names are the same
 * tokens the ccb-arena UI uses, so the two panels feel cohesive.
 *
 * `falsified` and `mutated` are visually distinct: red ✗ for "wrong",
 * yellow ⤳ for "wrong-but-replaced". `stale` differs from `open` only
 * in glyph (`~` vs `○`) — both are dim because neither is actionable
 * right now.
 */
const STATUS_RENDER: Record<
  HypothesisStatus,
  { glyph: string; color?: 'success' | 'error' | 'warning'; dim: boolean }
> = {
  open: { glyph: '○', dim: true },
  evidence: { glyph: '●', color: 'success', dim: false },
  falsified: { glyph: '✗', color: 'error', dim: false },
  mutated: { glyph: '⤳', color: 'warning', dim: false },
  stale: { glyph: '~', dim: true },
}

/**
 * Hierarchical-numeric comparator used for sibling ordering. Splits on
 * `.`, strips the leading `H`, and compares each segment as an integer.
 * Falls back to lexical for non-numeric segments (defence — schema-
 * validated ids are always numeric).
 */
function compareHypothesisId(a: string, b: string): number {
  const aSegs = a.replace(/^H/, '').split('.')
  const bSegs = b.replace(/^H/, '').split('.')
  const len = Math.max(aSegs.length, bSegs.length)
  for (let i = 0; i < len; i += 1) {
    const aSeg = aSegs[i]
    const bSeg = bSegs[i]
    if (aSeg === undefined) return -1
    if (bSeg === undefined) return 1
    const aNum = Number.parseInt(aSeg, 10)
    const bNum = Number.parseInt(bSeg, 10)
    if (!Number.isFinite(aNum) || !Number.isFinite(bNum)) {
      if (aSeg < bSeg) return -1
      if (aSeg > bSeg) return 1
      continue
    }
    if (aNum !== bNum) return aNum - bNum
  }
  return 0
}

/** Truncate to a single line, max `max` chars, append `…` on overflow. */
function truncateOneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Build a parent → children map plus the list of root ids. We treat any
 * hypothesis whose declared `parentId` is missing from the snapshot as a
 * root (defence-in-depth — the live ledger should never have dangling
 * parents, but if it does we surface the orphan rather than dropping it).
 */
function indexTree(hypotheses: ReadonlyMap<string, Hypothesis>): {
  children: Map<string, string[]>
  roots: string[]
} {
  const children = new Map<string, string[]>()
  const roots: string[] = []
  for (const [id, h] of hypotheses) {
    if (h.parentId != null && hypotheses.has(h.parentId)) {
      const list = children.get(h.parentId) ?? []
      list.push(id)
      children.set(h.parentId, list)
    } else {
      roots.push(id)
    }
  }
  // Sort siblings deterministically.
  for (const list of children.values()) {
    list.sort(compareHypothesisId)
  }
  roots.sort(compareHypothesisId)
  return { children, roots }
}

/**
 * One rendered row. The runner produces a flat list via DFS, then this
 * component caps and renders.
 */
type Row = {
  id: string
  depth: number
  hypothesis: Hypothesis
}

function flattenDfs(
  ids: readonly string[],
  depth: number,
  hypotheses: ReadonlyMap<string, Hypothesis>,
  children: ReadonlyMap<string, readonly string[]>,
  out: Row[],
  cap: number,
): void {
  for (const id of ids) {
    if (out.length >= cap) return
    const h = hypotheses.get(id)
    if (!h) continue
    out.push({ id, depth, hypothesis: h })
    const kids = children.get(id) ?? []
    flattenDfs(kids, depth + 1, hypotheses, children, out, cap)
  }
}

/* -------------------------------------------------------------------------- */
/* Public component                                                           */
/* -------------------------------------------------------------------------- */

export function HypothesisTreeView(props: Props): React.ReactNode {
  const { hypotheses } = props
  const maxRows = props.maxRows ?? DEFAULT_MAX_ROWS

  if (hypotheses.size === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Hypothesis ledger</Text>
        <Text dimColor>(no hypotheses yet)</Text>
      </Box>
    )
  }

  const { children, roots } = indexTree(hypotheses)
  // Compute ALL rows first so the overflow tally is exact, then cap.
  const all: Row[] = []
  flattenDfs(roots, 0, hypotheses, children, all, Number.MAX_SAFE_INTEGER)
  const visible = all.slice(0, maxRows)
  const hiddenCount = all.length - visible.length

  return (
    <Box flexDirection="column">
      <Text bold>Hypothesis ledger ({hypotheses.size})</Text>
      {visible.map(row => (
        <HypothesisRow key={row.id} row={row} />
      ))}
      {hiddenCount > 0 ? (
        <Text dimColor>… (+{hiddenCount} more)</Text>
      ) : null}
    </Box>
  )
}

/**
 * One indented row rendering. The indent string is built from spaces
 * rather than a tree-art glyph so terminals without unicode box-
 * drawing characters render legibly too.
 */
function HypothesisRow({ row }: { row: Row }): React.ReactNode {
  const { hypothesis: h, depth } = row
  const render = STATUS_RENDER[h.status]
  const indent = depth > 0 ? '  '.repeat(depth) : ''
  const conf = h.confidence.toFixed(2)
  const text = truncateOneLine(h.text, 60)
  const line = `${indent}${render.glyph} ${h.id} [${h.status}] (${h.kind}) "${text}" conf=${conf}`
  if (render.color) {
    return (
      <Text color={render.color} dimColor={render.dim}>
        {line}
      </Text>
    )
  }
  return <Text dimColor={render.dim}>{line}</Text>
}

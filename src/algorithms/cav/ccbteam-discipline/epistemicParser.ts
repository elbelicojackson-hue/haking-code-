/**
 * T18 — `<epistemic>` block parser + 5-rule check (R13-4..R13-9).
 *
 * Algorithm 4 from design.md. Pure function; fails closed (returns
 * `verdict=null` on any defect, never throws).
 *
 * Hard rules (audited):
 *   - Never throws — even on malformed JSON / missing block / type
 *     mismatch (R13-7 / R13-8).
 *   - Returns `{ verdict: null, violations: [] }` for missing /
 *     unparseable input; the sidecar treats those as `degradation`
 *     events (`epistemic-missing` / `epistemic-malformed`).
 *   - Pure / deterministic / no I/O.
 *
 * Cross-references:
 *   - .kiro/specs/super-agent-cluster/requirements.md → R13
 *   - .kiro/specs/super-agent-cluster/design.md → "Algorithm 4"
 */

import { z } from 'zod'

import { KNOWLEDGE_ZONES } from '../ccbteam-math/constants.js'
import type {
  EpistemicParseResult,
  EpistemicPriorFlags,
  EpistemicViolation,
} from '../ccbteam-math/types.js'

/* -------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* -------------------------------------------------------------------------- */

/** `YYYY-MM` (1900-2099) or the literal `unknown`. */
const TRAINING_CUTOFF_RE = /^(?:(?:19|20)\d{2}-(?:0[1-9]|1[0-2])|unknown)$/

export const EpistemicVerdictSchema = z.strictObject({
  knowledge_zone: z.enum(KNOWLEDGE_ZONES),
  training_cutoff_aware: z.string().regex(TRAINING_CUTOFF_RE),
  oracle_used: z.union([z.string().min(1).max(200), z.null()]),
  claim_grounded_in: z.string().min(1).max(500),
  refusal_when_unknown: z.boolean(),
})

const EPISTEMIC_BLOCK_RE = /```epistemic\s*([\s\S]*?)```/u

/* -------------------------------------------------------------------------- */
/* parseAndCheckEpistemic                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Extract + validate + check the `<epistemic>` block in a teammate
 * output.
 *
 * @param teammateOutput  full assistant text for the round (CAV block
 *                        + content + epistemic block).
 * @param priorFlags      side-channel hints used for [E5] check.
 *
 * @returns `{ verdict: <parsed> | null, violations: [...] }`. Verdict
 *          null means "no usable signal"; violations is empty in that
 *          case (we don't fabricate rule failures from absence).
 */
export function parseAndCheckEpistemic(
  teammateOutput: string,
  priorFlags: EpistemicPriorFlags,
): EpistemicParseResult {
  const match = EPISTEMIC_BLOCK_RE.exec(teammateOutput)
  if (!match) {
    return { verdict: null, violations: [] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(match[1]!.trim())
  } catch {
    return { verdict: null, violations: [] }
  }

  const safe = EpistemicVerdictSchema.safeParse(parsed)
  if (!safe.success) {
    return { verdict: null, violations: [] }
  }
  const v = safe.data

  const violations: EpistemicViolation[] = []

  // [E1] outside + no oracle → must refuse.
  if (
    v.knowledge_zone === 'outside' &&
    v.oracle_used === null &&
    v.refusal_when_unknown !== true
  ) {
    violations.push({
      ruleId: 'E1',
      details: 'outside zone, no oracle, but did not refuse',
    })
  }

  // [E2] handled at schema level (regex on training_cutoff_aware).

  // [E3] claim_grounded_in non-empty (also enforced by schema min(1)).
  // Defence-in-depth — strip whitespace.
  if (v.claim_grounded_in.trim().length === 0) {
    violations.push({
      ruleId: 'E3',
      details: 'claim_grounded_in is empty after trim',
    })
  }

  // [E4] oracle_used reference must show up in claim_grounded_in.
  if (v.oracle_used !== null) {
    const oracleId = extractOracleId(v.oracle_used)
    if (!v.claim_grounded_in.includes(oracleId)) {
      violations.push({
        ruleId: 'E4',
        details: `oracle_used "${truncate(v.oracle_used, 60)}" not referenced in claim_grounded_in`,
      })
    }
  }

  // [E5] flagged last round → repair_style ∈ {concede, split}.
  if (priorFlags.wasFlaggedAsBoundaryViolation) {
    const cavStyle = extractRepairStyle(teammateOutput)
    if (cavStyle && cavStyle !== 'concede' && cavStyle !== 'split') {
      violations.push({
        ruleId: 'E5',
        details: `flagged last round, but repair_style=${cavStyle}`,
      })
    }
  }

  return { verdict: v, violations }
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Heuristic: pull a stable token out of an `oracle_used` value so [E4]
 * can compare against `claim_grounded_in`. We pick the longest run of
 * `[A-Za-z0-9_-]` plus optionally a leading `oracle:` prefix.
 */
function extractOracleId(oracle: string): string {
  const match = /(?:oracle:)?[A-Za-z0-9._-]+/i.exec(oracle)
  return match ? match[0] : oracle
}

/**
 * Local copy of the `repair_style` extractor used by `observer.ts`. We
 * don't import observer.ts because that would pull in the runtime
 * effect graph; we just re-implement the regex.
 */
function extractRepairStyle(text: string): string | null {
  const cavMatch = /```cav\s*([\s\S]*?)```/u.exec(text)
  if (!cavMatch) return null
  try {
    const obj = JSON.parse(cavMatch[1]!.trim()) as Record<string, unknown>
    const style = obj.repair_style
    return typeof style === 'string' ? style : null
  } catch {
    return null
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...'
}

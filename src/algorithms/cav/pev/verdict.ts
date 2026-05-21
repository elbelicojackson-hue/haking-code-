/**
 * PEV Verdict Engine — pure regex-driven judgement of tool stdout.
 *
 * Given a {@link ToolPlan} and the raw stdout/exitCode from the executed
 * tool, this module returns a deterministic {@link Verdict} plus the
 * matched pattern's `RegExp.source` (or a sentinel) for audit. No LLM is
 * consulted; all "semantic" interpretation of tool output must instead
 * be expressed by the agent in its `op === 'mutate'` proposal (see R8-6
 * — `mutates` is set by the ledger reducer, not here).
 *
 * Hard rules (audited):
 *   - Pure function: no I/O, no `Date.now`, no LLM, no environment
 *     access. Every call with the same inputs returns deeply-equal
 *     output (Property 9 — referential transparency).
 *   - Performance: ≤ 50 ms on ≤ 1 MB stdout. Inputs > 1 MB are truncated
 *     to the first 100 KB before regex scanning to bound worst-case
 *     ReDoS exposure (R8-8).
 *   - `exitCode` is intentionally NOT consulted to flip a confirmed
 *     pattern. A non-zero exit with no pattern match falls through to
 *     `inconclusive` via the no-match branch (R8-2).
 *   - When confirms AND falsifies both match, we deliberately surface
 *     the conflict via `matchedPattern: 'pattern-conflict'` rather than
 *     silently picking one — the agent must mutate the hypothesis or
 *     the operator must investigate.
 *
 * Cross-references:
 *   - .kiro/specs/ccb-pev-re-execution-loop/design.md → Component 6,
 *     Algorithm 2, Property 9
 *   - .kiro/specs/ccb-pev-re-execution-loop/requirements.md → R8-1 ..
 *     R8-8
 */

import type { ToolPlan } from './canonicalTests.js'
import type { Verdict } from './protocol.js'

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Truncation threshold. Anything strictly larger than this (1 MB chars)
 * is sliced to {@link TRUNCATE_TARGET} chars before regex scanning.
 * "1 MB" here is character-based, not byte-based — JS strings are UTF-16
 * code units; this is intentional and matches design.md / R8-8.
 */
export const TRUNCATE_THRESHOLD = 1_000_000 as const

/**
 * Truncation target. Once the stdout exceeds {@link TRUNCATE_THRESHOLD},
 * we keep only the first {@link TRUNCATE_TARGET} chars. Tool output
 * format conventions (banner / first match) make the leading region the
 * most signal-dense; tail-truncation is rejected to avoid truncating
 * the legitimate first match.
 */
export const TRUNCATE_TARGET = 100_000 as const

/**
 * Sentinel `matchedPattern` value used when both `confirms` and
 * `falsifies` match. Surfaced verbatim so callers can grep / log it.
 */
export const PATTERN_CONFLICT_SENTINEL = 'pattern-conflict' as const

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The fixed return shape from {@link judgeVerdict}.
 *
 * Fields:
 *   - `verdict`         — one of the 4 {@link Verdict} values. The
 *                         engine itself never returns `'mutates'`; that
 *                         status is created by the ledger reducer when
 *                         an agent submits `op === 'mutate'` (R8-6).
 *   - `matchedPattern`  — `RegExp.source` of the winning regex, or the
 *                         {@link PATTERN_CONFLICT_SENTINEL} string when
 *                         both confirms+falsifies hit, or `null` when
 *                         no pattern matched at all.
 *   - `truncated`       — `true` when the input exceeded
 *                         {@link TRUNCATE_THRESHOLD} and was sliced.
 */
export type VerdictResult = {
  readonly verdict: Verdict
  readonly matchedPattern: string | null
  readonly truncated: boolean
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Find the first regex in `patterns` that tests true against `text`.
 * Returns its `source` string, or `null` if none match.
 *
 * The scan short-circuits on the first hit (Algorithm 2, R8-3 / R8-4).
 * We deliberately do NOT use `Array.prototype.find` + `.source` here so
 * the implementation stays a single readable loop with an explicit
 * early-exit (auditable + no callback allocation per element).
 */
function firstMatchingSource(
  patterns: readonly RegExp[],
  text: string,
): string | null {
  for (const re of patterns) {
    if (re.test(text)) return re.source
  }
  return null
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Judge the verdict of a tool execution against the canonical plan it
 * was meant to test.
 *
 * Algorithm 2 (verbatim from design.md):
 *   1. If stdout > 1 MB chars, slice to first 100 KB; set truncated.
 *   2. Scan plan.confirms in order; record first hit's `source`.
 *   3. Scan plan.falsifies in order; record first hit's `source`.
 *   4. Both hit  → inconclusive + 'pattern-conflict'
 *   5. Only confirms → 'confirms' + confirmsHit
 *   6. Only falsifies → 'falsifies' + falsifiesHit
 *   7. Neither → 'inconclusive' + null (covers exitCode≠0 no-match too)
 *
 * Note on `exitCode`: it is accepted as part of the public contract for
 * forward-compat (the runner already has it on hand from the tool
 * adapter), but the engine intentionally does not branch on it. A
 * non-zero exit with no pattern match returns `inconclusive` via step 7;
 * a non-zero exit WITH a pattern match still surfaces that pattern,
 * which is the desired behaviour for tools that exit non-zero on the
 * very signal we are looking for (e.g. `upx -t` returning non-zero
 * "tested ok" on some builds).
 *
 * @param plan          The {@link ToolPlan} that was executed.
 * @param toolStdout    Raw stdout string (may be empty).
 * @param toolExitCode  Process exit code (currently unused; see note).
 * @returns             A {@link VerdictResult} record.
 */
export function judgeVerdict(
  plan: ToolPlan,
  toolStdout: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  toolExitCode: number,
): VerdictResult {
  // Step 1 — truncate if oversized.
  let scanText: string = toolStdout
  let truncated = false
  if (scanText.length > TRUNCATE_THRESHOLD) {
    scanText = scanText.slice(0, TRUNCATE_TARGET)
    truncated = true
  }

  // Steps 2-3 — scan both regex lists, recording the first hit per list.
  const confirmsHit = firstMatchingSource(plan.confirms, scanText)
  const falsifiesHit = firstMatchingSource(plan.falsifies, scanText)

  // Step 4 — pattern conflict.
  if (confirmsHit !== null && falsifiesHit !== null) {
    return {
      verdict: 'inconclusive',
      matchedPattern: PATTERN_CONFLICT_SENTINEL,
      truncated,
    }
  }

  // Step 5 — confirms only.
  if (confirmsHit !== null) {
    return { verdict: 'confirms', matchedPattern: confirmsHit, truncated }
  }

  // Step 6 — falsifies only.
  if (falsifiesHit !== null) {
    return { verdict: 'falsifies', matchedPattern: falsifiesHit, truncated }
  }

  // Step 7 — neither matched. Covers exitCode ≠ 0 with no pattern hit.
  return { verdict: 'inconclusive', matchedPattern: null, truncated }
}

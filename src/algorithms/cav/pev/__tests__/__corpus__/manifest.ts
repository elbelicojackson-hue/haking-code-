/**
 * Corpus manifest for `parser.test.ts`. Each entry binds a sample file
 * (under `__corpus__/`) to its expected parse outcome and the validator
 * context the parser should be run with.
 *
 * Two canonical ledger setups are used so every sample only has to refer
 * to evidence/hypothesis ids that are actually present:
 *   - `empty`    — no hypotheses, no evidence (only `create` ops legal)
 *   - `seeded`   — `H1` (open, confidence 0.7) + evidence `E1`
 *
 * The expected `selfAgentId` is always `static_analyst` and `round` is
 * always `0` — keeping the corpus narrow makes the table easier to audit
 * without diluting parser coverage (the parser cares about *shape*; the
 * validator's identity/round checks are exercised separately in
 * validator.test.ts).
 */

export type ExpectedOutcome =
  | { kind: 'ok'; layerHit: 1 | 2 | 3 }
  | { kind: 'err'; errorKind: string }

export type LedgerKey = 'empty' | 'seeded'

export type CorpusEntry = {
  /** File name relative to `__corpus__/`. */
  file: string
  /** Short human-readable label printed by the test runner. */
  label: string
  /** Which canonical ledger this sample is parsed against. */
  ledger: LedgerKey
  /** Expected parse outcome. */
  expected: ExpectedOutcome
}

/**
 * The corpus table. Order is purely cosmetic — tests iterate.
 *
 * Coverage targets:
 *   - 5 Layer-1 happy paths covering different ops + next_action kinds
 *   - 5 Layer-2 fixable defects (one per repair feature)
 *   - 3 missing-fenced-block cases
 *   - 3 hard-broken JSON cases (Layer-2 also fails)
 *   - 4 edge cases (CRLF, leading whitespace, mixed lang fence, comments)
 */
export const CORPUS: readonly CorpusEntry[] = [
  // ----- Layer 1 happy paths -----
  {
    file: 'L1_01_create_packer.md',
    label: 'L1 — create new packer hypothesis',
    ledger: 'empty',
    expected: { kind: 'ok', layerHit: 1 },
  },
  {
    file: 'L1_02_promote_h1.md',
    label: 'L1 — promote pre-seeded H1 with observation',
    ledger: 'seeded',
    expected: { kind: 'ok', layerHit: 1 },
  },
  {
    file: 'L1_03_tool_call.md',
    label: 'L1 — tool_call against H1',
    ledger: 'seeded',
    expected: { kind: 'ok', layerHit: 1 },
  },
  {
    file: 'L1_04_request_oracle.md',
    label: 'L1 — request_oracle next_action',
    ledger: 'empty',
    expected: { kind: 'ok', layerHit: 1 },
  },
  {
    file: 'L1_05_declare_done.md',
    label: 'L1 — declare_done next_action',
    ledger: 'seeded',
    expected: { kind: 'ok', layerHit: 1 },
  },

  // ----- Layer 2 fixables -----
  {
    file: 'L2_01_trailing_comma.md',
    label: 'L2 — trailing comma in arrays/objects',
    ledger: 'empty',
    expected: { kind: 'ok', layerHit: 2 },
  },
  {
    file: 'L2_02_single_quotes.md',
    label: "L2 — single-quoted strings",
    ledger: 'empty',
    expected: { kind: 'ok', layerHit: 2 },
  },
  {
    file: 'L2_03_unquoted_keys.md',
    label: 'L2 — unquoted object keys',
    ledger: 'empty',
    expected: { kind: 'ok', layerHit: 2 },
  },
  {
    file: 'L2_04_missing_schema_version.md',
    label: 'L2 — missing schema_version key',
    ledger: 'empty',
    expected: { kind: 'ok', layerHit: 2 },
  },
  {
    file: 'L2_05_camel_case.md',
    label: 'L2 — camelCase aliases (nextAction etc.)',
    ledger: 'seeded',
    expected: { kind: 'ok', layerHit: 2 },
  },

  // ----- Missing fenced block -----
  {
    file: 'NB_01_only_prose.md',
    label: 'NB — only prose, no fenced blocks at all',
    ledger: 'empty',
    expected: { kind: 'err', errorKind: 'no-fenced-block' },
  },
  {
    file: 'NB_02_only_cav_block.md',
    label: 'NB — has cav block but no pev block',
    ledger: 'empty',
    expected: { kind: 'err', errorKind: 'no-fenced-block' },
  },
  {
    file: 'NB_03_wrong_lang_tag.md',
    label: 'NB — block tagged ```json instead of ```pev',
    ledger: 'empty',
    expected: { kind: 'err', errorKind: 'no-fenced-block' },
  },

  // ----- Broken JSON beyond Layer-2 repair -----
  {
    file: 'BK_01_truncated.md',
    label: 'BK — pev block truncated mid-string',
    ledger: 'empty',
    expected: { kind: 'err', errorKind: 'json-parse-failed' },
  },
  {
    file: 'BK_02_garbled.md',
    label: 'BK — randomly garbled bytes inside pev block',
    ledger: 'empty',
    expected: { kind: 'err', errorKind: 'json-parse-failed' },
  },
  {
    file: 'BK_03_unbalanced_braces.md',
    label: 'BK — unbalanced braces',
    ledger: 'empty',
    expected: { kind: 'err', errorKind: 'json-parse-failed' },
  },

  // ----- Edge cases -----
  {
    file: 'EDGE_01_crlf.md',
    label: 'EDGE — CRLF line endings',
    ledger: 'empty',
    expected: { kind: 'ok', layerHit: 1 },
  },
  {
    file: 'EDGE_02_leading_whitespace.md',
    label: 'EDGE — leading whitespace before opening fence',
    ledger: 'empty',
    expected: { kind: 'ok', layerHit: 1 },
  },
  {
    file: 'EDGE_03_mixed_lang_fence.md',
    label: 'EDGE — fence tagged ```pev json',
    ledger: 'empty',
    expected: { kind: 'ok', layerHit: 1 },
  },
  {
    file: 'EDGE_04_comments_inside.md',
    label: 'EDGE — // and /* */ comments inside json',
    ledger: 'empty',
    expected: { kind: 'ok', layerHit: 2 },
  },
]

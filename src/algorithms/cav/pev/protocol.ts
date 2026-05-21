/**
 * PEV (Plan-Execute-Verify) Output Protocol — types + zod schemas.
 *
 * This file is the **协议第一公民**: every other PEV module (parser, validator,
 * ledger, scheduler, propagator, runner, UI) imports its types and schemas
 * from here. The protocol is the contract that turns LLM free-form output
 * into a deterministic state machine input.
 *
 * Hard rules (audited):
 *   - schema is module-level `as const` data; no JSON-file loading, no env
 *     overrides, no runtime mutability.
 *   - all object schemas use {@link z.strictObject} so unknown keys → reject.
 *   - all closed sets use {@link z.discriminatedUnion} with `op` / `kind`
 *     discriminators, never `type` / `action`.
 *   - HypothesisId is restricted to depth ≤ 4 (`^H\d+(\.\d+){0,3}$`) to
 *     prevent the model from spawning runaway hypothesis trees.
 *
 * See:
 *   - .kiro/specs/ccb-pev-re-execution-loop/design.md → Component 1, Model 5
 *   - .kiro/specs/ccb-pev-re-execution-loop/requirements.md → R1, R2, R3, R14-3
 */

import { z } from 'zod/v4'

/**
 * Literal version string carried in every PevOutput. We keep it as `'1.0'`
 * (not `'1.0.0'` or `'v1.0'`) — agents that ship `1.0.0` are rejected with
 * `errorKind: 'schema-mismatch'`. Bumping this is a breaking-protocol event.
 */
export const PEV_SCHEMA_VERSION = '1.0' as const

/**
 * HypothesisId: dot-separated nested integer levels, max depth 4.
 *
 * Examples:
 *   `H1`        — top-level hypothesis
 *   `H1.2`      — second child of H1
 *   `H1.2.3.4`  — deepest allowed
 *
 * Counter-examples (rejected):
 *   `H`, `H1.`, `H1.2.3.4.5`, `h1`, `H01`(leading zero ok per regex but
 *   semantically discouraged — the regex permits it for now).
 */
export const HypothesisIdSchema = z.string().regex(/^H\d+(\.\d+){0,3}$/)

/**
 * EvidenceId: monotonically-increasing tool-evidence id. Agents do **not**
 * mint these — the ledger generates `E${lastEvidenceId+1}` on each
 * appendEvidence call. Schema validates the surface format only.
 */
export const EvidenceIdSchema = z.string().regex(/^E\d+$/)

/**
 * The 8 fixed Reverse-Engineering hypothesis kinds. Each kind has its own
 * canonical test plans (see canonicalTests.ts) and its own derive-rule
 * mapping (see propagator.ts).
 */
export const HypothesisKindSchema = z.enum([
  'file-class',
  'packer',
  'compiler',
  'family',
  'algorithm',
  'anti-analysis',
  'capability',
  'protocol',
])

/**
 * VerdictEngine output — never a free-form string. `mutates` means "old H
 * is wrong but the evidence proposes a new H to take its place" (see
 * Component 6 / R8-6).
 */
export const VerdictSchema = z.enum([
  'confirms',
  'falsifies',
  'mutates',
  'inconclusive',
])

/**
 * One observation = one verdict claim about an evidence already in the
 * ledger. The agent does NOT create evidence ids; it cites them.
 */
export const ObservationSchema = z.strictObject({
  evidence_id: EvidenceIdSchema,
  verdict: VerdictSchema,
  confidence: z.number().min(0).max(1),
})

/**
 * ToolPlanId format: `<kind>::<slug>`, e.g. `packer::diec`,
 * `algorithm::ida-script-dump`. Lowercase + hyphen + double-colon only.
 */
export const ToolPlanIdSchema = z.string().regex(/^[a-z-]+::[a-z0-9-]+$/)

/**
 * `args_override` is either `null` (use plan defaults) or an object whose
 * keys MUST be a subset of the plan's `overridable_fields`. The schema
 * itself can't enforce the subset constraint (it depends on the looked-up
 * plan); that check lives in validator.ts.
 */
export const ArgsOverrideSchema = z.record(z.string(), z.unknown()).nullable()

/**
 * The 5 hypothesis-update operations. discriminator = `op`. Each branch
 * has its own required field set; missing-or-extra fields → strictObject
 * rejection.
 */
export const HypothesisUpdateSchema = z.discriminatedUnion('op', [
  /**
   * `create` — register a brand-new hypothesis. `parent_id` is optional
   * (omit for top-level root hypotheses); when provided, validator.ts
   * enforces that the parent already exists and belongs to the same
   * session.
   */
  z.strictObject({
    op: z.literal('create'),
    id: HypothesisIdSchema,
    parent_id: HypothesisIdSchema.nullable().optional(),
    kind: HypothesisKindSchema,
    text: z.string().min(5).max(500),
    confidence: z.number().min(0).max(1),
  }),
  /**
   * `promote` — move a hypothesis from `open` to `evidence`. Only legal
   * when the agent already submitted an observation that confirms it.
   */
  z.strictObject({
    op: z.literal('promote'),
    id: HypothesisIdSchema,
    rationale_short: z.string().min(5).max(300),
  }),
  /**
   * `falsify` — kill a hypothesis. `counter_evidence_id` must point to an
   * existing evidence in the ledger. Triggers stale cascade for the
   * subtree (see scheduler.ts / R7-3).
   */
  z.strictObject({
    op: z.literal('falsify'),
    id: HypothesisIdSchema,
    counter_evidence_id: EvidenceIdSchema,
    rationale_short: z.string().min(5).max(300),
  }),
  /**
   * `mutate` — replace `id` with `new_id`. Old H gets `mutated` status,
   * new H is registered as `open`. Used when evidence falsifies the
   * literal claim but suggests a near-miss alternative.
   */
  z.strictObject({
    op: z.literal('mutate'),
    id: HypothesisIdSchema,
    new_id: HypothesisIdSchema,
    text: z.string().min(5).max(500),
    confidence: z.number().min(0).max(1),
    rationale_short: z.string().min(5).max(300),
  }),
  /**
   * `confidence_adjust` — change confidence within reason. Validator
   * enforces `|new - old| ≤ 0.5` to prevent silent flip-flopping (R2-5).
   * Also the only legal way to resurrect a stale H (set ≥ 0.5).
   */
  z.strictObject({
    op: z.literal('confidence_adjust'),
    id: HypothesisIdSchema,
    new_confidence: z.number().min(0).max(1),
    rationale_short: z.string().min(5).max(300),
  }),
])

/**
 * The 4 next-action kinds. discriminator = `kind` (NOT `type` or `action`,
 * see R3-6). Scheduler dispatches based on this; full-observe round
 * triggers stall guard (R7-7).
 */
export const NextActionSchema = z.discriminatedUnion('kind', [
  /**
   * `tool_call` — request to run a canonical plan against a hypothesis.
   * Validator checks: hypothesis exists & status ∈ {open, evidence};
   * tool_plan_id is in CANONICAL_TESTS; args_override keys ⊆
   * plan.overridable_fields.
   */
  z.strictObject({
    kind: z.literal('tool_call'),
    hypothesis_id: HypothesisIdSchema,
    tool_plan_id: ToolPlanIdSchema,
    args_override: ArgsOverrideSchema,
  }),
  /**
   * `observe_only` — pass for this round, do not consume tool budget.
   */
  z.strictObject({
    kind: z.literal('observe_only'),
    rationale: z.string().min(5).max(300),
  }),
  /**
   * `request_oracle` — ask scheduler to run a web/oracle query
   * (WebSearch / Firecrawl). Scheduler picks the actual tool.
   */
  z.strictObject({
    kind: z.literal('request_oracle'),
    query: z.string().min(3).max(500),
    rationale: z.string().min(5).max(300),
  }),
  /**
   * `declare_done` — agent reports its slice is finished. Subsequent
   * rounds for this agent will only be allowed observe_only.
   */
  z.strictObject({
    kind: z.literal('declare_done'),
    rationale: z.string().min(5).max(500),
  }),
])

/**
 * Top-level PevOutput. Lives inside the ` ```pev ` fenced code block. Any
 * unknown root key → strictObject rejection.
 *
 * Field caps (R1-7, R1-8):
 *   - `observations`         max 8 entries
 *   - `hypothesis_updates`   max 8 entries
 *   - `agent_id`             1..64 chars
 */
export const PevOutputSchema = z.strictObject({
  schema_version: z.literal(PEV_SCHEMA_VERSION),
  agent_id: z.string().min(1).max(64),
  round: z.number().int().min(0),
  observations: z.array(ObservationSchema).max(8),
  hypothesis_updates: z.array(HypothesisUpdateSchema).max(8),
  next_action: NextActionSchema,
})

/* -------------------------------------------------------------------------- */
/* Inferred TypeScript types — exported as the canonical names downstream     */
/* modules import. We intentionally re-export `z.infer<typeof X>` instead of  */
/* hand-writing types, so the TS view never drifts from the runtime view.    */
/* -------------------------------------------------------------------------- */

export type PevOutput = z.infer<typeof PevOutputSchema>
export type HypothesisUpdate = z.infer<typeof HypothesisUpdateSchema>
export type NextAction = z.infer<typeof NextActionSchema>
export type Observation = z.infer<typeof ObservationSchema>
export type HypothesisKind = z.infer<typeof HypothesisKindSchema>
export type Verdict = z.infer<typeof VerdictSchema>
export type HypothesisId = z.infer<typeof HypothesisIdSchema>
export type EvidenceId = z.infer<typeof EvidenceIdSchema>
export type ToolPlanId = z.infer<typeof ToolPlanIdSchema>
export type ArgsOverride = z.infer<typeof ArgsOverrideSchema>

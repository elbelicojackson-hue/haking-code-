/**
 * PEV Output Cross-Validator — semantic checks beyond zod schema.
 *
 * The zod schema in `protocol.ts` enforces shape (string regexes, branch
 * required-fields, value ranges). It cannot enforce **referential
 * integrity** against the live ledger or **per-op state-machine legality**
 * (e.g. you can't promote a stale H, you can't falsify an unknown id, you
 * can't tool-call a hypothesis that doesn't exist). That's this module's
 * job.
 *
 * Hard rules:
 *   - Pure function: no I/O, no globals, no `Date.now()`. The ledger is
 *     read through a structural {@link LedgerView} interface so this file
 *     does not need to import from `ledger.ts` (which doesn't exist yet
 *     during T2). When `ledger.ts` lands, its `SharedLedger` is
 *     structurally assignable to `LedgerView`.
 *   - First-error semantics: returns on the first failure. Bulk-error
 *     reporting is intentionally NOT done — the parser's Layer 3 retry
 *     prompt is much more useful when it can target one concrete defect.
 *   - The `findToolPlan` injection (NOT a hard import) avoids a circular
 *     dependency with `canonicalTests.ts` (T5). Callers who don't have a
 *     plan table yet can omit the field; in that case the tool_plan_id
 *     surface check is skipped (parser will still catch via T3).
 *
 * See:
 *   - .kiro/specs/ccb-pev-re-execution-loop/design.md → Component 4
 *   - .kiro/specs/ccb-pev-re-execution-loop/requirements.md → R1-5, R1-6,
 *     R2-1, R2-3, R2-6, R3-1, R3-2, R4-7, R7-9
 */

import type { PevOutput } from './protocol.js'

/* -------------------------------------------------------------------------- */
/* ParseErrorKind — the canonical error vocabulary                            */
/* -------------------------------------------------------------------------- */

/**
 * The full vocabulary of recoverable parse / validation errors. Declared
 * here (and not in `protocol.ts`) because parser.ts (T3) and validator.ts
 * share the type — the parser layers add `'no-fenced-block'`,
 * `'json-parse-failed'`, `'schema-mismatch'`, `'retry-exhausted'`; the
 * validator emits the rest.
 *
 * **Stability**: this is a closed set. New kinds are protocol-breaking;
 * downstream UI (`PevSession`) and persistence (`PevEvalLog`) display
 * them as-is.
 */
export type ParseErrorKind =
  // Parser-layer kinds (consumed by parser.ts, declared here so all
  // downstream code imports the canonical type from one module):
  | 'no-fenced-block'
  | 'json-parse-failed'
  | 'schema-mismatch'
  | 'retry-exhausted'
  // Validator-layer kinds:
  | 'identity-mismatch'
  | 'round-mismatch'
  | 'unknown-evidence'
  | 'unknown-hypothesis'
  | 'unknown-parent'
  | 'id-collision'
  | 'illegal-promote'
  | 'illegal-on-stale'
  | 'self-contradiction'
  | 'invalid-confidence-jump'
  | 'unknown-tool-plan'
  | 'invalid-args-override'
  | 'illegal-tool-call'

/**
 * Result of a single `validatePevOutput` call. Uses a discriminated union
 * (not `Error` throwing) because validation failures are **expected** for
 * adversarial / messy LLM output — the runner consumes this result to
 * decide between "drop this round's PEV segment" vs "trigger Layer 3
 * retry".
 */
export type ValidationResult =
  | { ok: true }
  | { ok: false; errorKind: ParseErrorKind; detail: string }

/* -------------------------------------------------------------------------- */
/* LedgerView — minimal structural read-side interface                        */
/* -------------------------------------------------------------------------- */

/**
 * The minimal slice of `SharedLedger` (T4) the validator reads. We declare
 * it inline so this module compiles before T4 lands; `SharedLedger` will
 * be structurally assignable to `LedgerView` because it has the same
 * field names with stricter element types (the validator only cares about
 * `.id`, `.status`, `.confidence`).
 *
 * Element types use the 5-state HypothesisStatus enum from the design
 * (Model 1). Reserved values: `'open' | 'evidence' | 'falsified' |
 * 'mutated' | 'stale'`.
 */
export type LedgerView = {
  hypotheses: ReadonlyMap<
    string,
    {
      id: string
      status: 'open' | 'evidence' | 'falsified' | 'mutated' | 'stale'
      confidence: number
    }
  >
  evidenceLog: readonly { id: string }[]
}

/**
 * Context passed to `validatePevOutput`. Pure data — no callbacks beyond
 * the optional plan-lookup function used to break the canonicalTests
 * import cycle.
 */
export type ValidatorContext = {
  /** The agent id this PEV output is *expected* to be from. */
  selfAgentId: string
  /** The runner's current round counter. */
  round: number
  /** Live ledger snapshot. Validator does NOT mutate. */
  ledger: LedgerView
  /**
   * Optional plan lookup, injected by the runner once `canonicalTests.ts`
   * (T5) is loaded. When absent the tool_plan_id and args_override checks
   * are skipped — the parser will still surface them on its next layer.
   */
  findToolPlan?: (
    id: string,
  ) => { overridable_fields: readonly string[] } | undefined
}

/* -------------------------------------------------------------------------- */
/* Internal helpers (pure)                                                    */
/* -------------------------------------------------------------------------- */

/** Build a Set of evidence ids for O(1) membership tests. */
function evidenceIdSet(ledger: LedgerView): ReadonlySet<string> {
  const s = new Set<string>()
  for (const ev of ledger.evidenceLog) s.add(ev.id)
  return s
}

/* -------------------------------------------------------------------------- */
/* validatePevOutput — the public entry point                                 */
/* -------------------------------------------------------------------------- */

/**
 * Validate a zod-parsed `PevOutput` against a ledger snapshot. Pure
 * function: same `(parsed, ctx)` always returns the same result.
 *
 * Validation order is fixed (and matters for error-attribution clarity):
 *   1. agent_id == selfAgentId         → 'identity-mismatch'
 *   2. round    == ctx.round           → 'round-mismatch'
 *   3. observations[].evidence_id ∈ ledger → 'unknown-evidence'
 *   4. hypothesis_updates self-contradiction (promote ∩ falsify on same id)
 *      → 'self-contradiction'
 *   5. per-op semantic checks (5 branches × ledger snapshot)
 *   6. next_action: tool_call referential integrity
 *
 * @param parsed PEV output that has already passed `PevOutputSchema`.
 * @param ctx    Validator context — see {@link ValidatorContext}.
 */
export function validatePevOutput(
  parsed: PevOutput,
  ctx: ValidatorContext,
): ValidationResult {
  // 1. Identity
  if (parsed.agent_id !== ctx.selfAgentId) {
    return {
      ok: false,
      errorKind: 'identity-mismatch',
      detail: `agent_id="${parsed.agent_id}" but expected "${ctx.selfAgentId}"`,
    }
  }

  // 2. Round
  if (parsed.round !== ctx.round) {
    return {
      ok: false,
      errorKind: 'round-mismatch',
      detail: `round=${parsed.round} but expected ${ctx.round}`,
    }
  }

  const evidenceIds = evidenceIdSet(ctx.ledger)
  const hyp = ctx.ledger.hypotheses

  // 3. Observations referential integrity
  for (let i = 0; i < parsed.observations.length; i++) {
    const obs = parsed.observations[i]!
    if (!evidenceIds.has(obs.evidence_id)) {
      return {
        ok: false,
        errorKind: 'unknown-evidence',
        detail: `observations[${i}].evidence_id="${obs.evidence_id}" not in ledger`,
      }
    }
  }

  // 4. Self-contradiction: promote + falsify on the same id within the
  //    SAME hypothesis_updates array. This is `R2-6` and is checked here
  //    (not by zod) because zod doesn't see across array elements.
  const promoteIds = new Set<string>()
  const falsifyIds = new Set<string>()
  for (const u of parsed.hypothesis_updates) {
    if (u.op === 'promote') promoteIds.add(u.id)
    else if (u.op === 'falsify') falsifyIds.add(u.id)
  }
  for (const id of promoteIds) {
    if (falsifyIds.has(id)) {
      return {
        ok: false,
        errorKind: 'self-contradiction',
        detail: `hypothesis_updates contains both 'promote' and 'falsify' for id="${id}"`,
      }
    }
  }

  // 5. Per-op semantic checks. We validate against the LEDGER SNAPSHOT,
  //    not against an evolving in-array state — i.e. if the same array
  //    creates H1 then promotes H1, the promote will be rejected. This
  //    is intentional: chained ops within one round are confusing for
  //    the LLM and easy to bug; force a one-op-at-a-time discipline.
  for (let i = 0; i < parsed.hypothesis_updates.length; i++) {
    const u = parsed.hypothesis_updates[i]!

    switch (u.op) {
      case 'create': {
        if (hyp.has(u.id)) {
          return {
            ok: false,
            errorKind: 'id-collision',
            detail: `hypothesis_updates[${i}] tries to create id="${u.id}" but it already exists in ledger`,
          }
        }
        // parent_id is optional + nullable; only check when present and
        // non-null.
        if (u.parent_id != null && !hyp.has(u.parent_id)) {
          return {
            ok: false,
            errorKind: 'unknown-parent',
            detail: `hypothesis_updates[${i}].parent_id="${u.parent_id}" not in ledger`,
          }
        }
        break
      }

      case 'promote': {
        const h = hyp.get(u.id)
        if (!h) {
          // Per R2-2 wording: "id 必须已存在且 status === 'open'(否则
          // errorKind: 'illegal-promote')" — both failure modes map to
          // illegal-promote.
          return {
            ok: false,
            errorKind: 'illegal-promote',
            detail: `hypothesis_updates[${i}] promotes unknown id="${u.id}"`,
          }
        }
        if (h.status === 'stale') {
          // R7-9: promote/mutate against a stale H is illegal-on-stale,
          // not illegal-promote. The 'stale' check has higher specificity
          // than the generic non-open check, so it's evaluated first.
          return {
            ok: false,
            errorKind: 'illegal-on-stale',
            detail: `hypothesis_updates[${i}] cannot promote stale id="${u.id}"`,
          }
        }
        if (h.status !== 'open') {
          return {
            ok: false,
            errorKind: 'illegal-promote',
            detail: `hypothesis_updates[${i}] promotes id="${u.id}" with status="${h.status}", expected "open"`,
          }
        }
        break
      }

      case 'falsify': {
        const h = hyp.get(u.id)
        if (!h) {
          return {
            ok: false,
            errorKind: 'unknown-hypothesis',
            detail: `hypothesis_updates[${i}] falsifies unknown id="${u.id}"`,
          }
        }
        if (h.status === 'stale') {
          return {
            ok: false,
            errorKind: 'illegal-on-stale',
            detail: `hypothesis_updates[${i}] cannot falsify stale id="${u.id}"`,
          }
        }
        if (!evidenceIds.has(u.counter_evidence_id)) {
          return {
            ok: false,
            errorKind: 'unknown-evidence',
            detail: `hypothesis_updates[${i}].counter_evidence_id="${u.counter_evidence_id}" not in ledger`,
          }
        }
        break
      }

      case 'mutate': {
        const h = hyp.get(u.id)
        if (!h) {
          return {
            ok: false,
            errorKind: 'unknown-hypothesis',
            detail: `hypothesis_updates[${i}] mutates unknown id="${u.id}"`,
          }
        }
        if (h.status === 'stale') {
          return {
            ok: false,
            errorKind: 'illegal-on-stale',
            detail: `hypothesis_updates[${i}] cannot mutate stale id="${u.id}"`,
          }
        }
        if (hyp.has(u.new_id)) {
          return {
            ok: false,
            errorKind: 'id-collision',
            detail: `hypothesis_updates[${i}].new_id="${u.new_id}" already exists in ledger`,
          }
        }
        break
      }

      case 'confidence_adjust': {
        const h = hyp.get(u.id)
        if (!h) {
          return {
            ok: false,
            errorKind: 'unknown-hypothesis',
            detail: `hypothesis_updates[${i}] adjusts unknown id="${u.id}"`,
          }
        }
        // R2-5: |Δ| ≤ 0.5 — prevents silent flip-flop. Use a small fp
        // epsilon to tolerate 0.5 exactly even with rounding.
        const delta = Math.abs(u.new_confidence - h.confidence)
        if (delta > 0.5 + 1e-9) {
          return {
            ok: false,
            errorKind: 'invalid-confidence-jump',
            detail: `hypothesis_updates[${i}] confidence delta ${delta.toFixed(3)} > 0.5 for id="${u.id}"`,
          }
        }
        // R7-9 resurrect rule: stale H can ONLY be revived by
        // confidence_adjust with new_confidence ≥ 0.5. Below that it's
        // still illegal-on-stale (you're still telling us the H is
        // weak — don't revive it).
        if (h.status === 'stale' && u.new_confidence < 0.5) {
          return {
            ok: false,
            errorKind: 'illegal-on-stale',
            detail: `hypothesis_updates[${i}] cannot resurrect stale id="${u.id}" with new_confidence=${u.new_confidence} (< 0.5)`,
          }
        }
        break
      }
    }
  }

  // 6. NextAction — only tool_call needs cross-validation; the other 3
  //    kinds (observe_only / request_oracle / declare_done) are pure
  //    declarations and zod already constrained their fields.
  const action = parsed.next_action
  if (action.kind === 'tool_call') {
    const h = hyp.get(action.hypothesis_id)
    if (!h) {
      return {
        ok: false,
        errorKind: 'illegal-tool-call',
        detail: `next_action.hypothesis_id="${action.hypothesis_id}" not in ledger`,
      }
    }
    if (h.status === 'stale') {
      return {
        ok: false,
        errorKind: 'illegal-on-stale',
        detail: `next_action targets stale hypothesis_id="${action.hypothesis_id}"`,
      }
    }
    if (h.status !== 'open' && h.status !== 'evidence') {
      // falsified / mutated — not a valid testing target.
      return {
        ok: false,
        errorKind: 'illegal-tool-call',
        detail: `next_action targets hypothesis_id="${action.hypothesis_id}" with status="${h.status}", expected "open" or "evidence"`,
      }
    }

    // Tool-plan checks are skipped if the lookup function isn't injected
    // (typical during early bring-up before T5). Once injected, both the
    // existence of the plan and the args_override key set are enforced.
    if (ctx.findToolPlan) {
      const plan = ctx.findToolPlan(action.tool_plan_id)
      if (!plan) {
        return {
          ok: false,
          errorKind: 'unknown-tool-plan',
          detail: `next_action.tool_plan_id="${action.tool_plan_id}" not found in canonical tests`,
        }
      }
      if (action.args_override != null) {
        const allowed = new Set(plan.overridable_fields)
        for (const key of Object.keys(action.args_override)) {
          if (!allowed.has(key)) {
            return {
              ok: false,
              errorKind: 'invalid-args-override',
              detail: `next_action.args_override key "${key}" not in plan.overridable_fields=[${plan.overridable_fields.join(', ')}]`,
            }
          }
        }
      }
    }
  }

  return { ok: true }
}

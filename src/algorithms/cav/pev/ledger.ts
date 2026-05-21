/**
 * SharedLedger — pure-function reducer over Hypothesis + ToolEvidence state.
 *
 * The ledger is the **process-owned**, immutable snapshot of every
 * hypothesis and every evidence the PEV loop has ever seen. Agents do not
 * write to it directly; they propose `HypothesisUpdate` operations that
 * are first checked by `validator.ts` (T2) and then applied here.
 *
 * Hard rules (audited):
 *   - Every reducer is a pure function: same inputs → same outputs, no
 *     I/O, no `Date.now()`, no mutable globals.
 *   - Every reducer returns a **new** {@link SharedLedger} object — even
 *     for no-op skip paths. Tests assert `Object.is(input, output) ===
 *     false` to guarantee callers can never accidentally observe a
 *     mid-update state. The new wrapper also makes time-travel (replay
 *     for debugging) trivial.
 *   - `lastEvidenceId` is monotonically non-decreasing. Only
 *     {@link appendEvidence} bumps it; agents do NOT mint evidence ids.
 *   - The validator (T2) is the source of truth for legality. The
 *     reducer additionally guards against state-corrupting ops as a
 *     defence-in-depth: when the validator missed a case (e.g. a
 *     bug-fix lag, or a path that bypasses validator), the reducer
 *     skips the op and emits a `console.debug`. This means **invalid ops
 *     are silently no-ops, not exceptions** — the runner stays alive.
 *
 * See:
 *   - .kiro/specs/ccb-pev-re-execution-loop/design.md → Component 2,
 *     Models 1, 2, 4
 *   - .kiro/specs/ccb-pev-re-execution-loop/requirements.md → R6-1 ..
 *     R6-9, R7-3, R7-8
 */

import type {
  EvidenceId,
  HypothesisId,
  HypothesisKind,
  HypothesisUpdate,
  Verdict,
} from './protocol.js'

/* -------------------------------------------------------------------------- */
/* Types — all readonly, all aligned with design Model 1, 2, 4                */
/* -------------------------------------------------------------------------- */

/**
 * The 5 Hypothesis lifecycle states.
 *
 * Transitions (single-direction, NEVER reversed except via the explicit
 * resurrect rule R7-9):
 *   - `open`       initial state on `create`
 *   - `evidence`   `open` + `promote`
 *   - `falsified`  `open|evidence` + `falsify`
 *   - `mutated`    `open|evidence` + `mutate` (the OLD id; new_id is
 *                  registered as a fresh `open`)
 *   - `stale`      cascade-only, set when an ancestor was falsified
 *                  (R7-3, R7-8)
 *
 * The structural view used by `validator.ts` (T2) is a subset of this
 * enum — the alignment is intentional so `SharedLedger` is structurally
 * assignable to `LedgerView`.
 */
export type HypothesisStatus =
  | 'open'
  | 'evidence'
  | 'falsified'
  | 'mutated'
  | 'stale'

/**
 * A single hypothesis record. Field meanings:
 *   - `id`                    hierarchical id, max depth 4
 *   - `ownerAgent`            agent that introduced it
 *   - `kind`                  one of the 8 RE hypothesis kinds
 *   - `text`                  human-readable claim
 *   - `confidence`            ∈ [0, 1]
 *   - `status`                see {@link HypothesisStatus}
 *   - `parentId`              optional parent in the H-tree
 *   - `evidenceTrail`         every evidence id that touched this H
 *   - `derivedFromEvidence`   set when this H was born out of a `mutate`
 *                             (currently always undefined — the original
 *                             evidence link is reconstructable via the
 *                             parent's evidenceTrail; future runners may
 *                             populate this for direct lookup)
 *   - `createdRound`          round at which `create` was applied
 *   - `lastTouchedRound`      round at which any reducer last touched it
 */
export type Hypothesis = {
  readonly id: HypothesisId
  readonly ownerAgent: string
  readonly kind: HypothesisKind
  readonly text: string
  readonly confidence: number
  readonly status: HypothesisStatus
  readonly parentId?: HypothesisId
  readonly evidenceTrail: readonly EvidenceId[]
  readonly derivedFromEvidence?: EvidenceId
  readonly createdRound: number
  readonly lastTouchedRound: number
}

/**
 * Outcome of a single tool execution. The verdict is computed by
 * `verdict.ts` (T6); this record only carries the result.
 */
export type ToolOutcome = 'success' | 'failure' | 'inconclusive'

/**
 * Causal verdict produced by `causalEngine.ts` when a plan supports
 * Pearl-style do-calculus intervention. Exposed here (rather than in
 * causalEngine.ts) so {@link ToolEvidence} can carry it as a structural
 * field without a runtime circular import.
 *
 * Semantics (full discussion in causalEngine.ts):
 *   - `causal-confirm`     intervention breaks the confirms signal →
 *                          true causation (Pearl Level 2)
 *   - `correlation-only`   signal persists despite intervention →
 *                          correlation, not causation
 *   - `causal-falsify`     original already falsifies; causal analysis
 *                          is trivial in this branch
 *   - `inconclusive`       original was inconclusive/mutates → cannot
 *                          determine causality
 */
export type CausalVerdict =
  | 'causal-confirm'
  | 'correlation-only'
  | 'causal-falsify'
  | 'inconclusive'

/**
 * Captured tool-call evidence. `id` is generated by the ledger
 * ({@link appendEvidence} returns it) — agents do NOT mint these. The
 * `resultDigest` is a length-bounded summary (head 400 + tail 100 ≤ 500
 * chars, see R6-3) — full stdout is NOT stored.
 */
export type ToolEvidence = {
  readonly id: EvidenceId
  readonly agentId: string
  readonly round: number
  /**
   * One of the 6 allow-listed tool names. Typed as `string` to dodge a
   * cyclic import with `canonicalTests.ts` (T5); callers should narrow
   * to `ToolName` from there.
   */
  readonly toolName: string
  /** Already-redacted by the runner (apiKeys etc removed). */
  readonly toolArgs: unknown
  readonly outcome: ToolOutcome
  /** Length-bounded digest, ≤ 500 chars (head 400 + tail 100). */
  readonly resultDigest: string
  readonly testedHypothesis: HypothesisId
  readonly verdict: Verdict
  readonly newHypothesisProposal?: string
  readonly durationMs: number
  readonly costTokens?: number
  /**
   * The canonical plan id that produced this evidence (e.g.
   * `packer::diec`). Optional for backward compat with legacy ledgers
   * that pre-date the structural-causal upgrade. New runner code MUST
   * populate this whenever the evidence came from a `findToolPlan`
   * lookup.
   */
  readonly planId?: string
  /**
   * Set when this evidence is itself the **intervention variant** of a
   * causal pair (i.e. the second of two evidence rows produced by a
   * single tool_call against an intervention-registered plan). Combined
   * with `planId`, this lets downstream code look up the original
   * evidence by scanning `evidenceLog` for the same `planId` +
   * `testedHypothesis` + `round` triple with `isCausalIntervention`
   * absent.
   */
  readonly isCausalIntervention?: boolean
  /**
   * Causal verdict — populated ONLY on the intervention evidence (the
   * second row of a causal pair). The original evidence carries the
   * regular `verdict` field; the intervention row mirrors that AND adds
   * this structured causal classification so the scheduler / agents can
   * read it without parsing strings.
   */
  readonly causalVerdict?: CausalVerdict
  /**
   * Causal strength ∈ [0, 1] — populated on the intervention evidence.
   * Used by {@link applyCausalBoost} to weight EIG by ACTUAL causal
   * power rather than mere registry membership.
   */
  readonly causalStrength?: number
  /**
   * Free-text label describing the variable that was manipulated by
   * the do-calculus intervention (e.g. "TLS SNI extension presence").
   * Mirrored from `InterventionVariant.manipulatedVariable` for audit
   * + UI display.
   */
  readonly manipulatedVariable?: string
}

/**
 * Three-layer parser hit-rate counters; identical shape to the field on
 * the parser-internal struct so they can be merged at session-end for
 * the persistence file.
 */
export type ParseStats = {
  readonly layer1Hits: number
  readonly layer2Hits: number
  readonly layer3Hits: number
  readonly parseFailures: number
}

/**
 * The full PEV state container. This object is what every other module
 * passes around.
 *
 * Field invariants:
 *   - `lastEvidenceId` is the integer suffix of the most recently minted
 *     evidence id. Starts at 0; `E1` is the first id minted. Monotonic
 *     non-decreasing.
 *   - `toolBudgetRemaining ≥ 0`.
 *   - Every hypothesis in `hypotheses.values()` has the same `.id` as
 *     its map key.
 */
export type SharedLedger = {
  readonly hypotheses: ReadonlyMap<HypothesisId, Hypothesis>
  readonly evidenceLog: readonly ToolEvidence[]
  readonly toolBudgetRemaining: number
  readonly parseStats: ParseStats
  readonly lastEvidenceId: number
}

/* -------------------------------------------------------------------------- */
/* createEmptyLedger                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Construct a fresh ledger for the start of a PEV run. `initialBudget`
 * is the total tool-call budget (R6-1, default 24 from PevBudget).
 */
export function createEmptyLedger(initialBudget: number): SharedLedger {
  return {
    hypotheses: new Map(),
    evidenceLog: [],
    toolBudgetRemaining: Math.max(0, Math.floor(initialBudget)),
    parseStats: {
      layer1Hits: 0,
      layer2Hits: 0,
      layer3Hits: 0,
      parseFailures: 0,
    },
    lastEvidenceId: 0,
  }
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Return a copy of the input ledger with a single hypothesis replaced (or
 * inserted). All other fields are shared (safe — they are themselves
 * immutable). Used by every per-op switch arm.
 */
function replaceHypothesis(
  ledger: SharedLedger,
  h: Hypothesis,
): SharedLedger {
  const next = new Map(ledger.hypotheses)
  next.set(h.id, h)
  return { ...ledger, hypotheses: next }
}

/**
 * No-op reducer — returns a fresh wrapper of the SAME ledger fields.
 * Identity differs (`Object.is(input, output) === false`) so callers
 * relying on the immutability invariant are happy. Used on validation-
 * skipped ops (the validator already rejected them; we never crash).
 */
function noopShallowClone(ledger: SharedLedger): SharedLedger {
  return { ...ledger }
}

/* -------------------------------------------------------------------------- */
/* applyHypothesisUpdate — the per-op switch                                  */
/* -------------------------------------------------------------------------- */

/**
 * Apply one validated `HypothesisUpdate` to the ledger.
 *
 * **Pre-condition** (assumed, not enforced): `update` already passed
 * `validatePevOutput`. If it didn't, the reducer falls back to a
 * defensive no-op + `console.debug` rather than throwing — the PEV loop
 * stays alive even when the validator and reducer disagree.
 *
 * @param ledger  current snapshot, never mutated
 * @param update  one HypothesisUpdate from a PevOutput
 * @param agentId the agent that emitted the update (becomes ownerAgent
 *                for `create` and the new H of `mutate`)
 * @param round   the current round counter (becomes createdRound /
 *                lastTouchedRound)
 */
export function applyHypothesisUpdate(
  ledger: SharedLedger,
  update: HypothesisUpdate,
  agentId: string,
  round: number,
): SharedLedger {
  switch (update.op) {
    case 'create': {
      if (ledger.hypotheses.has(update.id)) {
        // Validator should have flagged 'id-collision'; defence-in-depth.
        console.debug(
          `[pev/ledger] skip create: id="${update.id}" already exists`,
        )
        return noopShallowClone(ledger)
      }
      // parent_id is optional|nullable in the schema. Treat null and
      // undefined identically — both mean "no parent".
      const parentId =
        update.parent_id != null ? update.parent_id : undefined
      const newH: Hypothesis = {
        id: update.id,
        ownerAgent: agentId,
        kind: update.kind,
        text: update.text,
        confidence: update.confidence,
        status: 'open',
        parentId,
        evidenceTrail: [],
        createdRound: round,
        lastTouchedRound: round,
      }
      return replaceHypothesis(ledger, newH)
    }

    case 'promote': {
      const h = ledger.hypotheses.get(update.id)
      if (!h) {
        console.debug(`[pev/ledger] skip promote: id="${update.id}" not found`)
        return noopShallowClone(ledger)
      }
      // Validator enforces status === 'open'; defence-in-depth checks
      // here too. Promoting an already-evidence H is a no-op (idempotent).
      if (h.status !== 'open') {
        console.debug(
          `[pev/ledger] skip promote: id="${update.id}" status="${h.status}", expected "open"`,
        )
        return noopShallowClone(ledger)
      }
      return replaceHypothesis(ledger, {
        ...h,
        status: 'evidence',
        lastTouchedRound: round,
      })
    }

    case 'falsify': {
      const h = ledger.hypotheses.get(update.id)
      if (!h) {
        console.debug(`[pev/ledger] skip falsify: id="${update.id}" not found`)
        return noopShallowClone(ledger)
      }
      // Append the counter_evidence_id to the trail. Idempotency: if it's
      // already there, don't double-append.
      const trail = h.evidenceTrail.includes(update.counter_evidence_id)
        ? h.evidenceTrail
        : [...h.evidenceTrail, update.counter_evidence_id]
      return replaceHypothesis(ledger, {
        ...h,
        status: 'falsified',
        confidence: 0,
        lastTouchedRound: round,
        evidenceTrail: trail,
      })
    }

    case 'mutate': {
      const oldH = ledger.hypotheses.get(update.id)
      if (!oldH) {
        console.debug(
          `[pev/ledger] skip mutate: id="${update.id}" not found`,
        )
        return noopShallowClone(ledger)
      }
      if (ledger.hypotheses.has(update.new_id)) {
        console.debug(
          `[pev/ledger] skip mutate: new_id="${update.new_id}" already exists`,
        )
        return noopShallowClone(ledger)
      }
      // Mark the old H as `mutated`, then insert the fresh `open` H. We
      // copy the kind from the old H — the schema doesn't carry kind on
      // mutate, on the assumption that mutation refines wording / scope
      // within the same hypothesis category.
      const mutatedOld: Hypothesis = {
        ...oldH,
        status: 'mutated',
        lastTouchedRound: round,
      }
      const newH: Hypothesis = {
        id: update.new_id,
        ownerAgent: agentId,
        kind: oldH.kind,
        text: update.text,
        confidence: update.confidence,
        status: 'open',
        parentId: oldH.parentId,
        evidenceTrail: [],
        createdRound: round,
        lastTouchedRound: round,
      }
      const next = new Map(ledger.hypotheses)
      next.set(mutatedOld.id, mutatedOld)
      next.set(newH.id, newH)
      return { ...ledger, hypotheses: next }
    }

    case 'confidence_adjust': {
      const h = ledger.hypotheses.get(update.id)
      if (!h) {
        console.debug(
          `[pev/ledger] skip confidence_adjust: id="${update.id}" not found`,
        )
        return noopShallowClone(ledger)
      }
      // R2-5 / validator: |Δ| ≤ 0.5. Defence-in-depth check here so the
      // reducer never silently flip-flops state if a validator regression
      // ever lands.
      const delta = Math.abs(update.new_confidence - h.confidence)
      if (delta > 0.5 + 1e-9) {
        console.debug(
          `[pev/ledger] skip confidence_adjust: delta=${delta.toFixed(3)} > 0.5 for id="${update.id}"`,
        )
        return noopShallowClone(ledger)
      }
      return replaceHypothesis(ledger, {
        ...h,
        confidence: update.new_confidence,
        lastTouchedRound: round,
      })
    }

    default: {
      // Exhaustiveness guard. If a future op kind is added to the schema
      // without updating this switch, TS will catch it at compile time.
      const _exhaust: never = update
      void _exhaust
      console.debug('[pev/ledger] skip unknown op (exhaustiveness fallthrough)')
      return noopShallowClone(ledger)
    }
  }
}

/* -------------------------------------------------------------------------- */
/* appendEvidence                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Append a tool-evidence record to the ledger. The id is minted as
 * `E${lastEvidenceId+1}` — agents NEVER provide it. Also appends the
 * fresh evidence id to the targeted hypothesis's `evidenceTrail` (if the
 * H exists in the ledger).
 *
 * Returns both the new ledger AND the minted id, so the caller (runner)
 * can immediately reference it in subsequent updates within the same
 * round.
 */
export function appendEvidence(
  ledger: SharedLedger,
  ev: Omit<ToolEvidence, 'id'>,
): { ledger: SharedLedger; evidenceId: EvidenceId } {
  const nextNumeric = ledger.lastEvidenceId + 1
  const evidenceId: EvidenceId = `E${nextNumeric}`
  const fullEvidence: ToolEvidence = { ...ev, id: evidenceId }

  // Append to evidenceLog (new array — no in-place push).
  const evidenceLog: ToolEvidence[] = [...ledger.evidenceLog, fullEvidence]

  // Update the targeted H's evidenceTrail when present. If not present,
  // we still keep the evidence in the global log — orphaned evidence is
  // valid (e.g. inconclusive runs against deleted-via-mutate ids).
  let hypotheses = ledger.hypotheses
  const h = hypotheses.get(ev.testedHypothesis)
  if (h) {
    const trail = h.evidenceTrail.includes(evidenceId)
      ? h.evidenceTrail
      : [...h.evidenceTrail, evidenceId]
    const next = new Map(hypotheses)
    next.set(h.id, { ...h, evidenceTrail: trail })
    hypotheses = next
  }

  const newLedger: SharedLedger = {
    ...ledger,
    hypotheses,
    evidenceLog,
    lastEvidenceId: nextNumeric,
  }
  return { ledger: newLedger, evidenceId }
}

/* -------------------------------------------------------------------------- */
/* applyStaleCascade                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Mark every descendant of `startId` as `stale`. Single-direction
 * cascade per R7-8: parent falsify → descendants stale, **never** the
 * other way around. The `startId` itself is NOT modified — the caller
 * owns its status (typically just set to `falsified` or `mutated` by the
 * preceding reducer call).
 *
 * Status transitions:
 *   - descendant currently `open`     → `stale`
 *   - descendant currently `evidence` → `stale`
 *   - descendant currently `falsified` / `mutated` / `stale` → unchanged
 *     (do not overwrite a more-final state)
 *
 * Implementation is BFS over `parentId` pointers (we already have the
 * map keyed by id, so this is O(N) per call where N = ledger.hypotheses
 * size).
 */
export function applyStaleCascade(
  ledger: SharedLedger,
  startId: HypothesisId,
): SharedLedger {
  // Step 1: collect all descendants. We iterate the H map repeatedly
  // until no new descendants are added. The map size bounds the loop.
  const descendants = new Set<HypothesisId>()
  let added = true
  while (added) {
    added = false
    for (const [id, h] of ledger.hypotheses) {
      if (id === startId) continue
      if (descendants.has(id)) continue
      if (h.parentId === startId || (h.parentId && descendants.has(h.parentId))) {
        descendants.add(id)
        added = true
      }
    }
  }

  if (descendants.size === 0) {
    // Still return a fresh wrapper for the immutability invariant.
    return noopShallowClone(ledger)
  }

  const next = new Map(ledger.hypotheses)
  for (const id of descendants) {
    const h = next.get(id)
    if (!h) continue
    // Only overwrite open/evidence — preserve any final state.
    if (h.status === 'open' || h.status === 'evidence') {
      next.set(id, { ...h, status: 'stale' })
    }
  }
  return { ...ledger, hypotheses: next }
}

/* -------------------------------------------------------------------------- */
/* decrementBudget                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Subtract `n` from `toolBudgetRemaining`, flooring at zero. `n` defaults
 * to 1 — the typical case is "one tool call ran". Negative `n` is
 * silently clamped (we never grow the budget; that's a different op the
 * design doesn't expose).
 */
export function decrementBudget(ledger: SharedLedger, n = 1): SharedLedger {
  const dec = Math.max(0, Math.floor(n))
  const next = Math.max(0, ledger.toolBudgetRemaining - dec)
  return { ...ledger, toolBudgetRemaining: next }
}

/* -------------------------------------------------------------------------- */
/* incrementParseStats                                                        */
/* -------------------------------------------------------------------------- */

/** Discriminator for {@link incrementParseStats}. */
export type ParseStatsKind = 'layer1' | 'layer2' | 'layer3' | 'failure'

/**
 * Increment one counter on `parseStats`. Runner calls this after each
 * agent's PEV-segment parse attempt completes.
 */
export function incrementParseStats(
  ledger: SharedLedger,
  kind: ParseStatsKind,
): SharedLedger {
  const s = ledger.parseStats
  const nextStats: ParseStats =
    kind === 'layer1'
      ? { ...s, layer1Hits: s.layer1Hits + 1 }
      : kind === 'layer2'
        ? { ...s, layer2Hits: s.layer2Hits + 1 }
        : kind === 'layer3'
          ? { ...s, layer3Hits: s.layer3Hits + 1 }
          : { ...s, parseFailures: s.parseFailures + 1 }
  return { ...ledger, parseStats: nextStats }
}

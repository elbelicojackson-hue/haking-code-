/**
 * Scheduler — pure-function dispatcher that decides, for each agent in
 * the current round, which hypothesis to test and which canonical tool
 * plan to use.
 *
 * Hard rules (audited):
 *   - **Pure function**: no I/O, no `Date.now()`, no global state.
 *     Same `(ledger, agents, currentRound, budget)` ⇒ same result.
 *   - **Stale propagation is NOT scheduler's job** (R7-3, R7-8). The
 *     ledger's `applyStaleCascade` reducer (T4) marks descendants of a
 *     falsified hypothesis as `stale`. The scheduler only **respects**
 *     that status — `stale` / `falsified` / `mutated` hypotheses are
 *     filtered out of the candidate pool.
 *   - **In-flight tool calls are runner-owned** (R7-5). The scheduler
 *     does not see "is this H currently being tested by an in-flight
 *     call". It only sees the persisted evidence log.
 *   - **lastTouchedRound exclusion** (R7-6): a hypothesis is a candidate
 *     this round only when `h.lastTouchedRound < currentRound`. This
 *     prevents re-allocating the same H back to the same agent within
 *     the same round (which would only happen on retries today, but the
 *     guard is cheap and future-proofs against multi-pass schedules).
 *   - **Deterministic tie-break** (R7-6): when multiple candidate H share
 *     the maximum confidence, the lowest `id` (lexicographic) wins. This
 *     keeps tests reproducible and makes off-by-one regressions visible.
 *   - **Plan exhaustion is by tool name** (per design.md algorithm 1):
 *     a plan is considered "tested" when an evidence exists in
 *     `ledger.evidenceLog` whose `testedHypothesis === candidate.id` and
 *     `toolName === plan.tool`. Multiple plans sharing a tool collapse
 *     into one slot — that's intentional in v1 of the protocol.
 *
 * Cross-references:
 *   - .kiro/specs/ccb-pev-re-execution-loop/design.md → Component 7,
 *     Algorithm 1, Properties 7, 8
 *   - .kiro/specs/ccb-pev-re-execution-loop/requirements.md → R7-1 ..
 *     R7-9
 */

import { getToolPlansForKind, type ToolPlan } from './canonicalTests.js'
import { applyCausalBoost } from './causalEngine.js'
import { computeEIG, computeExplorationBonus, rankCandidates, DEFAULT_EXPLORATION_WEIGHT, type EIGCandidate } from './eigEngine.js'
import type { Hypothesis, SharedLedger } from './ledger.js'
import type { HypothesisKind } from './protocol.js'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Minimal agent descriptor consumed by the scheduler. We deliberately
 * avoid importing `ArenaProvider` from `../arena/providers.js` here so
 * the scheduler has zero dependencies on the arena layer (and so unit
 * tests can construct fake agents trivially).
 *
 * `kind` is reserved for future tie-breaking when a kind-specialised
 * agent should prefer hypotheses matching its specialty; the current
 * implementation does NOT consult it (algorithm 1 in design.md doesn't
 * factor agent kind into selection). It is exposed today so callers can
 * adopt the field without a breaking change later.
 */
export type AgentDescriptor = {
  readonly id: string
  readonly kind?: HypothesisKind
}

/**
 * Per-agent guidance produced by the scheduler. Agents see this in their
 * prompt (see T9 promptBuilder) but the runner is the canonical
 * consumer: `tool_call` next-actions whose `hypothesis_id`/`tool_plan_id`
 * agree with the directive are the "expected" path; deviations are
 * tolerated but logged.
 *
 * Field meanings:
 *   - `suggestedHypothesisId` / `suggestedToolPlanId` — present together
 *     when the scheduler found a candidate H plus an untested plan.
 *   - `hint` — human-readable string describing why no concrete tool
 *     plan was suggested (e.g. "all plans exhausted"). The runner may
 *     forward this verbatim into the agent prompt.
 *
 * Cross-agent inbox concerns (`pushedEvidence`, `pushedHypotheses`,
 * `staleNotice`) live on the propagator's `AgentInbox` (T8) rather
 * than here — the scheduler is intentionally narrow.
 */
export type ScheduleDirective = {
  readonly suggestedHypothesisId?: string
  readonly suggestedToolPlanId?: string
  readonly hint?: string
  /** EIG score in bits (only present when strategy='eig'). */
  readonly eig?: number
}

/**
 * Scheduler strategy selector. Default is 'eig' (information-theoretic
 * optimal). 'greedy-confidence' is the legacy behaviour for backward
 * compatibility.
 */
export type SchedulerStrategy = 'greedy-confidence' | 'eig'

/**
 * The 4-dimension PEV budget object. Defined locally (rather than
 * imported from `pevRunner.ts` which doesn't exist yet at T7 time) to
 * keep the scheduler self-contained. The runner-side type will be
 * structurally compatible.
 */
export type PevBudget = {
  readonly maxRounds: number
  readonly maxToolCalls: number
  readonly maxTokens: number
  readonly maxWallClockMs: number
}

/**
 * Scheduler return shape. `stallGuardWarning` is `true` iff every agent
 * was assigned an observer-only directive (no candidate H, or every
 * candidate already touched this round). Two consecutive warnings
 * trigger the runner's `stall-guard` stop reason (R7-7) — the scheduler
 * itself never raises that; it only flags the warning.
 */
export type SchedulerResult = {
  readonly perAgentDirective: ReadonlyMap<string, ScheduleDirective>
  readonly stallGuardWarning: boolean
}

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Active hypothesis filter. Owner must match, status must be `open` or
 * `evidence` — `stale` / `falsified` / `mutated` are excluded so the
 * scheduler never assigns work to a dead hypothesis (R7-3).
 */
function isAgentActiveHypothesis(h: Hypothesis, agentId: string): boolean {
  if (h.ownerAgent !== agentId) return false
  return h.status === 'open' || h.status === 'evidence'
}

/**
 * Pick the highest-confidence candidate, breaking ties by `id`
 * lexicographically ascending. Returns `undefined` for an empty input —
 * caller decides whether that means "no work" or "observe only".
 *
 * The id tie-break is required by R7-6 to make scheduling deterministic
 * across runs; without it, Map iteration order would leak through.
 */
function pickHighestConfidence(
  candidates: readonly Hypothesis[],
): Hypothesis | undefined {
  if (candidates.length === 0) return undefined
  let best = candidates[0]!
  for (let i = 1; i < candidates.length; i += 1) {
    const cur = candidates[i]!
    if (cur.confidence > best.confidence) {
      best = cur
    } else if (cur.confidence === best.confidence && cur.id < best.id) {
      best = cur
    }
  }
  return best
}

/**
 * Find the first plan (in declaration order from {@link getToolPlansForKind})
 * for which no evidence exists tying its `tool` to the candidate
 * hypothesis. Returns `undefined` when every plan has an evidence record
 * — i.e. all plans for this kind have been exercised against this H.
 *
 * Implementation note: we build the set of "tested tools for this H" once
 * per call, then linear-scan the plans. For the realistic plan-count of
 * 3-5 per kind, this is well below any micro-optimisation threshold.
 */
function findUntestedPlan(
  candidate: Hypothesis,
  ledger: SharedLedger,
): ToolPlan | undefined {
  const plans = getToolPlansForKind(candidate.kind)
  if (plans.length === 0) return undefined

  const testedTools = new Set<string>()
  for (const ev of ledger.evidenceLog) {
    if (ev.testedHypothesis === candidate.id) {
      testedTools.add(ev.toolName)
    }
  }

  for (const plan of plans) {
    if (!testedTools.has(plan.tool)) return plan
  }
  return undefined
}

/* -------------------------------------------------------------------------- */
/* schedule — Algorithm 1                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Compute per-agent directives for the upcoming round.
 *
 * Algorithm (mirrors design.md → Algorithm 1):
 *   1. For each agent, collect their active hypotheses
 *      (owner-match, status ∈ {open, evidence}).
 *   2. Empty set ⇒ observer with hint "no own active H, observe".
 *   3. Filter to those NOT already touched this round
 *      (`lastTouchedRound < currentRound`).
 *   4. Empty filter ⇒ observer with hint "all touched, observe".
 *   5. Pick the highest-confidence H (tie-break by id ascending).
 *   6. Find the first canonical plan whose tool has not yet produced
 *      evidence on that H. If none exists, hint "all plans exhausted".
 *   7. Otherwise, emit `{suggestedHypothesisId, suggestedToolPlanId}`.
 *
 * `stallGuardWarning` is the boolean OR of "every agent got an observer
 * directive" — it lets the runner detect a stall over consecutive rounds
 * without re-walking the directive map.
 *
 * Pre-conditions (assumed, not enforced):
 *   - `ledger` is a valid SharedLedger snapshot.
 *   - `agents` ids are unique. Duplicate ids overwrite earlier directives;
 *     the runner is expected to deduplicate upstream.
 *
 * Post-conditions:
 *   - Returned map has exactly one entry per unique agent id in `agents`.
 *   - The ledger is NOT modified (pure function).
 *
 * @param ledger        immutable snapshot of the ledger
 * @param agents        the agents about to be dispatched this round
 * @param currentRound  the round counter the runner is about to start
 * @param _budget       the PevBudget (currently unused — kept on the
 *                      signature for runner-side forward-compat with
 *                      future budget-aware scheduling heuristics)
 */
export function schedule(
  ledger: SharedLedger,
  agents: readonly AgentDescriptor[],
  currentRound: number,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _budget?: PevBudget,
  strategy: SchedulerStrategy = 'eig',
  explorationWeight: number = DEFAULT_EXPLORATION_WEIGHT,
): SchedulerResult {
  const perAgentDirective = new Map<string, ScheduleDirective>()
  let observerCount = 0

  // Materialise hypotheses once. Iterating the Map per agent would be O(N*M);
  // a single pre-pass is O(N) and keeps the hot loop tight.
  const allHypotheses: Hypothesis[] = Array.from(ledger.hypotheses.values())

  for (const agent of agents) {
    const activeOwn: Hypothesis[] = allHypotheses.filter(h =>
      isAgentActiveHypothesis(h, agent.id),
    )

    if (activeOwn.length === 0) {
      perAgentDirective.set(agent.id, { hint: 'no own active H, observe' })
      observerCount += 1
      continue
    }

    // Filter to those not yet touched this round (R7-6).
    const fresh = activeOwn.filter(h => h.lastTouchedRound < currentRound)
    if (fresh.length === 0) {
      perAgentDirective.set(agent.id, { hint: 'all touched, observe' })
      observerCount += 1
      continue
    }

    // --- Strategy fork ---
    if (strategy === 'eig') {
      // EIG strategy: evaluate all (H, plan) pairs and pick the best.
      // Plans with causal intervention support get a 1.5× EIG boost
      // because they can distinguish causation from correlation.
      const eigCandidates: EIGCandidate[] = []
      for (const h of fresh) {
        const plans = getToolPlansForKind(h.kind)
        for (const plan of plans) {
          // Skip already-tested combinations
          const alreadyTested = ledger.evidenceLog.some(
            ev => ev.testedHypothesis === h.id && ev.toolName === plan.tool,
          )
          if (alreadyTested) continue
          const eigResult = computeEIG(h, plan, ledger)
          const bonus = computeExplorationBonus(h, plan, ledger, explorationWeight)
          const boostedEig = applyCausalBoost(eigResult.eig, plan.id, ledger)
          eigCandidates.push({
            hypothesis: h,
            plan,
            eig: boostedEig,
            explorationBonus: bonus,
            total: boostedEig + bonus,
            breakdown: eigResult.breakdown,
          })
        }
      }

      if (eigCandidates.length === 0) {
        perAgentDirective.set(agent.id, {
          suggestedHypothesisId: fresh[0]?.id,
          hint: 'all plans exhausted',
        })
        continue
      }

      const ranked = rankCandidates(eigCandidates)
      const best = ranked[0]!

      if (best.total < 0.01) {
        perAgentDirective.set(agent.id, {
          suggestedHypothesisId: best.hypothesis.id,
          hint: 'low-information: consider declare_done or mutate',
          eig: best.eig,
        })
        observerCount += 1
        continue
      }

      perAgentDirective.set(agent.id, {
        suggestedHypothesisId: best.hypothesis.id,
        suggestedToolPlanId: best.plan.id,
        eig: best.eig,
      })
    } else {
      // Legacy greedy-confidence strategy
      const candidate = pickHighestConfidence(fresh)
      if (!candidate) {
        perAgentDirective.set(agent.id, { hint: 'all touched, observe' })
        observerCount += 1
        continue
      }

      const plan = findUntestedPlan(candidate, ledger)
      if (plan === undefined) {
        perAgentDirective.set(agent.id, {
          suggestedHypothesisId: candidate.id,
          hint: 'all plans exhausted',
        })
        continue
      }

      perAgentDirective.set(agent.id, {
        suggestedHypothesisId: candidate.id,
        suggestedToolPlanId: plan.id,
      })
    }
  }

  const stallGuardWarning =
    agents.length > 0 && observerCount === agents.length

  return { perAgentDirective, stallGuardWarning }
}

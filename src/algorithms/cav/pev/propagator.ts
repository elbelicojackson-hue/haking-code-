/**
 * Cross-agent Propagator — pure-function inbox builder.
 *
 * Once the ledger has been updated for round N-1 (evidence appended,
 * hypotheses promoted/falsified/staled), the propagator decides — for
 * each agent about to be dispatched in round N — what fresh information
 * they should see in their prompt. Three streams flow through:
 *
 *   1. **Lateral evidence push** — every evidence produced in
 *      `currentRound - 1` is pushed to peer agents whose active
 *      hypothesis kinds are either the same as, or a DERIVE_RULES child
 *      of, the tested hypothesis's kind. The producing agent itself is
 *      excluded (R9-8 self-feedback prevention).
 *
 *   2. **Vertical sub-hypothesis hints** — every hypothesis that landed
 *      on `status === 'evidence'` in `currentRound - 1` becomes a
 *      generator: for each child kind in `DERIVE_RULES[parent.kind]`, a
 *      synthetic Hypothesis record (status='open', confidence=0.3,
 *      parentId=parent.id) is dropped into the parent owner's
 *      `newHypothesisFromPeer`. The agent decides whether to actually
 *      `op: 'create'` it next round.
 *
 *   3. **Stale notices** — every hypothesis whose current status is
 *      `'stale'` gets its id pushed into its owner's `staleNotice` so
 *      the agent stops wasting tokens reasoning about a dead branch.
 *
 * Hard rules (audited):
 *   - **Pure function** (R9-1). No I/O, no `Date.now()`, no global
 *     state. Identical `(ledger, agents, currentRound)` ⇒ identical
 *     result.
 *   - **No self-feedback** (R9-8 / Property 10). An agent NEVER sees
 *     evidence whose `agentId` equals its own id in `newEvidenceForMe`.
 *     This is the central correctness invariant; the unit + PBT tests
 *     hammer it.
 *   - **Capped inboxes** (R9-6). Both `newEvidenceForMe` and
 *     `newHypothesisFromPeer` are capped at 5 items per agent. Evidence
 *     is sorted before truncation: confirms → falsifies → mutates →
 *     inconclusive (R9-7) — the most actionable signals survive a cap.
 *   - **Owner-targeted hints**. Sub-hypothesis hints land in the
 *     promoted H's `ownerAgent` only; peer agents see the lateral
 *     evidence stream instead.
 *   - **Hierarchical id minting**. Synthetic child ids look like
 *     `<parent>.<n>` where `n` is one greater than the highest direct-
 *     child index already in the ledger. We refuse to mint at depth 5+
 *     (the schema regex caps depth at 4).
 *
 * Cross-references:
 *   - .kiro/specs/ccb-pev-re-execution-loop/design.md → Component 8,
 *     Algorithm 4, Property 10
 *   - .kiro/specs/ccb-pev-re-execution-loop/requirements.md → R9-1 ..
 *     R9-8
 */

import type { Hypothesis, SharedLedger, ToolEvidence } from './ledger.js'
import type { HypothesisId, HypothesisKind, Verdict } from './protocol.js'
import type { AgentDescriptor } from './scheduler.js'
import { analyzeCommBound } from './commBound.js'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Per-agent inbox produced by the propagator. Every field is readonly to
 * mirror the immutability discipline elsewhere in the PEV layer.
 *
 * Field meanings:
 *   - `newEvidenceForMe`        Peer evidence relevant to this agent's
 *                               active hypotheses. Already capped to 5
 *                               and sorted confirms → falsifies →
 *                               mutates → inconclusive.
 *   - `newHypothesisFromPeer`   Synthetic sub-hypothesis hints derived
 *                               from this agent's recently-promoted H.
 *                               Capped to 5; agent is free to ignore.
 *   - `staleNotice`             Ids of this agent's hypotheses whose
 *                               status is currently `'stale'`.
 *   - `hintFromScheduler`       Reserved channel for future scheduler-
 *                               produced text hints. The propagator
 *                               itself never sets this; it is pre-
 *                               populated as `undefined` so callers can
 *                               splice scheduler hints in.
 */
export type AgentInbox = {
  readonly newEvidenceForMe: readonly ToolEvidence[]
  readonly newHypothesisFromPeer: readonly Hypothesis[]
  readonly staleNotice: readonly string[]
  readonly hintFromScheduler?: string
}

/** Return shape of {@link propagate}. */
export type PropagatorResult = {
  readonly perAgentInbox: ReadonlyMap<string, AgentInbox>
}

/* -------------------------------------------------------------------------- */
/* DERIVE_RULES                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Parent-kind → recommended child-kinds when the parent is confirmed.
 *
 * Rules (per design Component 8 + R9-5):
 *   - `file-class`   → packer (is it packed?), compiler (toolchain
 *                      fingerprint), capability (broad next probes)
 *   - `packer`       → compiler (after unpacking), capability
 *   - `compiler`     → algorithm (specific routine to dump),
 *                      capability (high-level features)
 *   - `family`       → capability (family-typical functionality),
 *                      protocol (C2 channel, etc.)
 *   - `algorithm`    → no further derivation (terminal node)
 *   - `anti-analysis`→ no further derivation (specific technique
 *                      already nailed down)
 *   - `capability`   → protocol (e.g. networking capability often
 *                      implies a wire protocol worth probing)
 *   - `protocol`     → no further derivation
 *
 * The table is `as const` and module-scoped — runtime-immutable per
 * R9-5. Adding a new kind requires editing this file and shipping a new
 * build; no env-driven extension.
 */
export const DERIVE_RULES: Readonly<
  Record<HypothesisKind, readonly HypothesisKind[]>
> = {
  'file-class': ['packer', 'compiler', 'capability'],
  packer: ['compiler', 'capability'],
  compiler: ['algorithm', 'capability'],
  family: ['capability', 'protocol'],
  algorithm: [],
  'anti-analysis': [],
  capability: ['protocol'],
  protocol: ['capability'],
} as const

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Hard cap on `newEvidenceForMe` and `newHypothesisFromPeer` per agent.
 * This is the DEFAULT value; the actual cap is dynamically computed from
 * the communication lower bound (Theorem 1) via `analyzeCommBound`.
 * When urgency is high, the adaptive bandwidth expands up to 12 to
 * accelerate convergence toward the theoretical floor.
 */
const DEFAULT_MAX_INBOX_ITEMS = 5

/**
 * Maximum hypothesis-id depth (`H1.2.3.4`). Mirrors the schema regex in
 * `protocol.ts` (`^H\d+(\.\d+){0,3}$`). The propagator refuses to mint
 * synthetic children below this depth.
 */
const MAX_HYPOTHESIS_DEPTH = 4

/**
 * Verdict-priority ordering. Lower number = higher priority = surfaces
 * first in the inbox (R9-7).
 *
 * Why this order:
 *   - `confirms`     positive signal, immediately actionable
 *   - `falsifies`    forces re-planning of dependent branches
 *   - `mutates`      semi-actionable (a near-miss; agent may want to
 *                    refine instead of pivot)
 *   - `inconclusive` lowest information density; surfaced last
 */
const VERDICT_PRIORITY: Readonly<Record<Verdict, number>> = {
  confirms: 0,
  falsifies: 1,
  mutates: 2,
  inconclusive: 3,
} as const

/* -------------------------------------------------------------------------- */
/* Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Compute the depth of a HypothesisId. `H1` is depth 1, `H1.2` is 2, the
 * deepest legal value `H1.2.3.4` is 4.
 */
function depthOf(id: string): number {
  // Count the dots; depth = dots + 1. We don't validate the regex here —
  // the ledger only ever contains schema-valid ids.
  const dots = id.match(/\./g)?.length ?? 0
  return dots + 1
}

/**
 * Find the next available direct-child index under `parentId`. Skips
 * grand-children (we only consider ids that look like `${parentId}.<n>`
 * with no further dots). Returns `1` for an unused parent.
 */
function findNextChildIndex(
  ledger: SharedLedger,
  parentId: HypothesisId,
): number {
  const prefix = `${parentId}.`
  let maxChild = 0
  for (const id of ledger.hypotheses.keys()) {
    if (!id.startsWith(prefix)) continue
    const rest = id.slice(prefix.length)
    if (rest.length === 0 || rest.includes('.')) continue
    const n = Number.parseInt(rest, 10)
    if (Number.isFinite(n) && n > maxChild) maxChild = n
  }
  return maxChild + 1
}

/**
 * Decide whether evidence whose tested hypothesis has kind `evKind` is
 * relevant to a peer agent that owns a hypothesis of kind `hKind`.
 *
 * Two routes accept:
 *   - same kind (a packer evidence speaks directly to a packer agent)
 *   - DERIVE_RULES[evKind].includes(hKind)
 *     (a confirmed packer suggests the next-round target is a compiler;
 *     so packer evidence is interesting to a compiler agent)
 *
 * The reverse direction (`DERIVE_RULES[hKind].includes(evKind)`) is
 * intentionally NOT a match — that would route, e.g., a `protocol`
 * evidence backwards to a `family` agent, which is rarely actionable in
 * practice and would dilute the most-relevant top-5 cap.
 */
function kindMatches(hKind: HypothesisKind, evKind: HypothesisKind): boolean {
  if (hKind === evKind) return true
  const derived = DERIVE_RULES[evKind] ?? []
  return derived.includes(hKind)
}

/* -------------------------------------------------------------------------- */
/* propagate — Algorithm 4                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Build the per-agent inbox for the upcoming round.
 *
 * Algorithm (mirrors design Algorithm 4):
 *   1. Initialise an empty inbox for every agent.
 *   2. Pre-bucket each agent's active hypotheses by ownerAgent (so the
 *      O(N×M) inner loop becomes O(N+M) over all agents).
 *   3. Lateral push: for each evidence in `evidenceLog` whose round is
 *      `currentRound - 1`, look up the kind of its tested hypothesis
 *      and push the evidence to every peer agent (≠ producer) that
 *      owns at least one active hypothesis with a matching kind (per
 *      `kindMatches`).
 *   4. Vertical hints: for every hypothesis with `status='evidence'`
 *      and `lastTouchedRound = currentRound - 1`, mint synthetic
 *      sub-hypothesis records — one per child kind in
 *      `DERIVE_RULES[h.kind]` — and drop them into the H's owner inbox.
 *   5. Stale notices: every `status='stale'` hypothesis pushes its id
 *      into its owner's `staleNotice`.
 *   6. Sort `newEvidenceForMe` by verdict priority, cap to 5. Cap
 *      `newHypothesisFromPeer` to 5 (declaration-order preserved).
 *
 * @param ledger        immutable ledger snapshot
 * @param agents        agents about to be dispatched this round
 * @param currentRound  the round counter the runner is about to start
 *                      (so `currentRound - 1` is "what just ran")
 */
export function propagate(
  ledger: SharedLedger,
  agents: readonly AgentDescriptor[],
  currentRound: number,
): PropagatorResult {
  // Internal mutable inbox shape — flipped to readonly at the very end.
  type MutableInbox = {
    newEvidenceForMe: ToolEvidence[]
    newHypothesisFromPeer: Hypothesis[]
    staleNotice: string[]
    hintFromScheduler?: string
  }

  // Step 1 — initialise inboxes (preserve duplicate agent ids by last
  // entry winning, mirroring scheduler.ts behaviour).
  const inboxes = new Map<string, MutableInbox>()
  for (const agent of agents) {
    inboxes.set(agent.id, {
      newEvidenceForMe: [],
      newHypothesisFromPeer: [],
      staleNotice: [],
    })
  }

  // Step 2 — pre-bucket active hypotheses by owner. We only care about
  // open / evidence; stale / falsified / mutated never count as "active"
  // for the purpose of relevance routing.
  const activeByOwner = new Map<string, Hypothesis[]>()
  for (const agent of agents) activeByOwner.set(agent.id, [])
  for (const h of ledger.hypotheses.values()) {
    if (h.status !== 'open' && h.status !== 'evidence') continue
    const list = activeByOwner.get(h.ownerAgent)
    if (list) list.push(h)
  }

  const targetRound = currentRound - 1

  // Step 3 — lateral evidence push. Skip when targetRound is negative
  // (round 0 has no predecessor, so nothing to propagate).
  if (targetRound >= 0) {
    for (const ev of ledger.evidenceLog) {
      if (ev.round !== targetRound) continue
      const testedH = ledger.hypotheses.get(ev.testedHypothesis)
      // Orphan evidence (tested H deleted/never registered) cannot route
      // by kind — drop it from lateral propagation. The agent will still
      // see it via the global ledger view in their prompt.
      if (!testedH) continue
      const evKind = testedH.kind

      for (const agent of agents) {
        // R9-8: never push the producing agent's evidence back to them.
        if (agent.id === ev.agentId) continue
        const own = activeByOwner.get(agent.id) ?? []
        // Relevance: at least one of the agent's active H matches by
        // kind (same or DERIVE_RULES child of evKind).
        const relevant = own.some(h => kindMatches(h.kind, evKind))
        if (!relevant) continue
        const inbox = inboxes.get(agent.id)
        if (!inbox) continue
        inbox.newEvidenceForMe.push(ev)
      }
    }
  }

  // Step 4 — vertical sub-hypothesis hints. Walk every hypothesis that
  // landed on 'evidence' in the previous round and synthesise a child
  // for each kind in DERIVE_RULES.
  if (targetRound >= 0) {
    for (const h of ledger.hypotheses.values()) {
      if (h.status !== 'evidence') continue
      if (h.lastTouchedRound !== targetRound) continue

      const childKinds = DERIVE_RULES[h.kind] ?? []
      if (childKinds.length === 0) continue

      // Refuse to mint at depth 5+ (regex cap is 4). The agent can still
      // refine via mutate / confidence_adjust; we just don't auto-
      // generate a child id beyond the regex.
      if (depthOf(h.id) >= MAX_HYPOTHESIS_DEPTH) continue

      const ownerInbox = inboxes.get(h.ownerAgent)
      if (!ownerInbox) continue

      let nextIdx = findNextChildIndex(ledger, h.id)
      for (const childKind of childKinds) {
        const childId: HypothesisId = `${h.id}.${nextIdx}`
        const synthetic: Hypothesis = {
          id: childId,
          ownerAgent: h.ownerAgent,
          kind: childKind,
          // Hint text is human-recognisable so the agent can spot it
          // when echoed in its prompt; the agent is expected to replace
          // this with a real claim during the next `op: 'create'`.
          text: `(hint) sub-hypothesis derived from ${h.id} (${h.kind} → ${childKind})`,
          confidence: 0.3,
          status: 'open',
          parentId: h.id,
          evidenceTrail: [],
          createdRound: currentRound,
          lastTouchedRound: currentRound,
        }
        ownerInbox.newHypothesisFromPeer.push(synthetic)
        nextIdx += 1
      }
    }
  }

  // Step 5 — stale notices. Independent of round; we always surface the
  // current snapshot of stale H to their owners.
  for (const h of ledger.hypotheses.values()) {
    if (h.status !== 'stale') continue
    const ownerInbox = inboxes.get(h.ownerAgent)
    if (!ownerInbox) continue
    if (!ownerInbox.staleNotice.includes(h.id)) {
      ownerInbox.staleNotice.push(h.id)
    }
  }

  // Step 6 — sort + cap. Stable-sort by verdict priority preserves
  // ledger insertion order within a verdict bucket, which is convenient
  // for tests and for agents reading the inbox top-to-bottom.
  //
  // Adaptive bandwidth (Theorem 1): when urgency is high, expand the
  // inbox cap to increase effective channel capacity B, pushing down
  // the communication lower bound R_min.
  const commAnalysis = analyzeCommBound(ledger, agents.length, currentRound)
  const maxInboxItems = commAnalysis.adaptiveBandwidth

  const finalInboxes = new Map<string, AgentInbox>()
  for (const [agentId, inbox] of inboxes) {
    const sortedEvidence = [...inbox.newEvidenceForMe].sort((a, b) => {
      const pa = VERDICT_PRIORITY[a.verdict] ?? 99
      const pb = VERDICT_PRIORITY[b.verdict] ?? 99
      return pa - pb
    })
    const cappedEvidence = sortedEvidence.slice(0, maxInboxItems)
    const cappedHypotheses = inbox.newHypothesisFromPeer.slice(
      0,
      maxInboxItems,
    )

    const finalised: AgentInbox = {
      newEvidenceForMe: cappedEvidence,
      newHypothesisFromPeer: cappedHypotheses,
      staleNotice: [...inbox.staleNotice],
      ...(inbox.hintFromScheduler !== undefined
        ? { hintFromScheduler: inbox.hintFromScheduler }
        : {}),
    }
    finalInboxes.set(agentId, finalised)
  }

  return { perAgentInbox: finalInboxes }
}

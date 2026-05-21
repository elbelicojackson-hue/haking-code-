/**
 * Math Layer 公共类型 — Pure Observer / CR-EIG / Discipline Layer.
 *
 * 单一来源:requirements.md R1-3 / R3-1 / R3-3 / R4-2 / R6-1 / R13-x
 * 与 design.md "Data Models" 段。每个类型字段都对应一条 Acceptance
 * Criterion 或 design 章节,不要自由扩展。
 *
 * 所有类型 readonly。`RankedGradient.modelChose` 是**唯一**可变字段,
 * 由 sidecar 在 round 结束后回填(R4-2)。
 */

import type { CavReading, CavRecord, ConsensusState, RepairStyle as CavRepairStyle } from '../types.js'
import type {
  Hypothesis,
  SharedLedger,
  ToolEvidence,
} from '../pev/ledger.js'
import type { ToolPlan } from '../pev/canonicalTests.js'
import type { CcbTeamProfile, CcbTeamProfileId } from '../../../commands/ccbteam/profiles/types.js'

/* -------------------------------------------------------------------------- */
/* Re-exports — keep RepairStyle reachable via this module                    */
/* -------------------------------------------------------------------------- */

export type RepairStyle = CavRepairStyle

/* -------------------------------------------------------------------------- */
/* Strategy mode (CLI / sidecar lifecycle)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Two-arm strategy switch. Anything else (`cr-eig`, `cr-eig+gtpo`) is
 * explicitly rejected at the CLI layer (R11-5) — they were dropped in
 * the Pure Observer rewrite per R5.
 */
export type StrategyMode = 'prompt-only' | 'observe'

/* -------------------------------------------------------------------------- */
/* CR-EIG core types (R1-3 / R6-1)                                            */
/* -------------------------------------------------------------------------- */

/**
 * Algorithm 1 7-step decomposition of the CR-EIG main score. Every
 * field is always present; non-applicable terms are `0` (e.g. no plan →
 * `costPenalty === 0`).
 */
export type CrEigBreakdown = {
  readonly baseEig: number
  readonly trustWeightedConfirm: number
  readonly trustWeightedFalsify: number
  readonly costPenalty: number
  readonly causalGain: number
  readonly urgencyBoost: number
  readonly explorationBonus: number
}

export type CrEigResult = {
  readonly crEig: number
  readonly breakdown: CrEigBreakdown
}

/**
 * Tunable weights of the CR-EIG main term. Defaults live in
 * `constants.DEFAULT_CR_EIG_WEIGHTS`.
 *
 * `useAdaptiveDelta=false` reverts to the constant `δ_0` baseline,
 * matching legacy `eigEngine.computeEIG` bit-for-bit (R2-7).
 */
export type CrEigWeights = {
  readonly lambdaCost: number
  readonly gammaCausal: number
  readonly kappaUrgency: number
  readonly gammaExplore: number
  readonly deltaZero: number
  readonly useAdaptiveDelta: boolean
}

/* -------------------------------------------------------------------------- */
/* Gradient + Candidate                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The 5 ∇H gradient axes referenced by V2 protocol §5½.3.
 * Lex-asc order is the canonical tie-break for {@link rankGradients}.
 */
export type GradientId = 'attack' | 'chain' | 'discretize' | 'oracle' | 'swap'

/**
 * A `∇H_attack` target — the role + claim text the attacker focuses on.
 * Used only by `buildCandidatesForGradient('attack', ...)`; opaque
 * upstream.
 */
export type AttackTarget = {
  readonly targetAgentId: string
  readonly targetClaimDigest: string
}

/**
 * Unit of CR-EIG scoring. Some ∇H axes carry a plan + hypothesis
 * (oracle when matched), others carry only a gradient id (chain /
 * discretize). All fields beyond `gradientId` are optional.
 */
export type Candidate = {
  readonly gradientId: GradientId
  readonly hypothesis?: Hypothesis
  readonly plan?: ToolPlan
  readonly oracleChannel?: string
  readonly attackTarget?: AttackTarget
}

/**
 * Context bundle threaded through `computeCrEig`. `cavMatrix` is the
 * latest reading per active teammate; `weights` is the user-overridden
 * `CrEigWeights` (or DEFAULT).
 */
export type CrEigCtx = {
  readonly ledger: SharedLedger
  readonly cavMatrix: readonly CavReading[]
  readonly profile: CcbTeamProfile
  readonly weights: CrEigWeights
  /**
   * The full record stream — needed when the CR-EIG urgency term has to
   * call `consensusUrgency` internally (R3-1 / Algorithm 1 step 5).
   */
  readonly records: readonly CavRecord[]
  /**
   * Oracle anchors derived from `profile.oracles` (one per item).
   * Sidecar pre-computes these once per session.
   */
  readonly oracleAnchors: readonly OracleAnchor[]
  /**
   * Round number at the time of computation; needed by R4-6
   * (`generic` profile cold-start oracle bonus when round < 2).
   */
  readonly round: number
}

/**
 * The output of `rankGradients`. `modelChose` is the **only** mutable
 * field — sidecar rewrites it in-place after the round resolves so
 * downstream audit log carries the model's actual pick (R4-2).
 */
export type RankedGradient = {
  readonly gradient: GradientId
  readonly crEig: number
  readonly breakdown: CrEigBreakdown
  readonly explanation: string
  modelChose: boolean
}

/* -------------------------------------------------------------------------- */
/* Exploitability / Urgency                                                   */
/* -------------------------------------------------------------------------- */

export type ExploitabilityResult = {
  readonly eps: number
  readonly perAgent: Readonly<Record<string, number>>
  readonly explanation: string
  /**
   * `false` when neither MI sample size nor any oracle anchor is
   * sufficient to estimate counterfactual utilities. Sidecar still
   * writes `eps = EPS_MAX` but flags the audit log accordingly.
   */
  readonly estimable: boolean
}

export type UrgencyComponents = {
  readonly maxBestResponseGain: number
  readonly miSampleSufficient: boolean
  readonly oracleAvailable: boolean
}

export type ConsensusUrgencyResult = {
  readonly rho: number
  readonly state: ConsensusState
  readonly components: UrgencyComponents
  /** Pass-through of {@link ExploitabilityResult.eps} for traceability. */
  readonly eps: number
}

/* -------------------------------------------------------------------------- */
/* Oracle Anchor                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Static anchor derived from `profile.oracles`. v1 uses the textual
 * description as `referenceText` and a deterministic hash as `id`.
 */
export type OracleAnchor = {
  readonly id: string
  readonly referenceText: string
  readonly source: 'profile' | 'firecrawl' | 'verifier-bundle'
}

/* -------------------------------------------------------------------------- */
/* Epistemic Verdict (R13)                                                    */
/* -------------------------------------------------------------------------- */

export type KnowledgeZone = 'core' | 'edge' | 'outside'

/**
 * 5-field self-report parsed from the teammate's `<epistemic>` block.
 * Strict shape — any deviation makes `parseAndCheckEpistemic` return
 * `verdict: null` (R13-8).
 */
export type EpistemicVerdict = {
  readonly knowledge_zone: KnowledgeZone
  /** `YYYY-MM` or literal `'unknown'`. */
  readonly training_cutoff_aware: string
  readonly oracle_used: string | null
  readonly claim_grounded_in: string
  readonly refusal_when_unknown: boolean
}

export type EpistemicRuleId = 'E1' | 'E2' | 'E3' | 'E4' | 'E5'

export type EpistemicViolation = {
  readonly ruleId: EpistemicRuleId
  readonly details: string
}

export type EpistemicParseResult = {
  readonly verdict: EpistemicVerdict | null
  readonly violations: readonly EpistemicViolation[]
}

/**
 * Side-channel hints fed into `parseAndCheckEpistemic` so it can check
 * E5 (the boundary-violation correction rule). Empty in normal use.
 */
export type EpistemicPriorFlags = {
  readonly wasFlaggedAsBoundaryViolation: boolean
  readonly agentId: string
}

/* -------------------------------------------------------------------------- */
/* Sidecar interfaces (kept here so command layer can import via barrel)      */
/* -------------------------------------------------------------------------- */

export type SidecarOptions = {
  readonly strategy: StrategyMode
  readonly weights: CrEigWeights
  readonly explain: boolean
  readonly sessionId: string
  readonly sessionDir: string
  readonly profileId: CcbTeamProfileId
  readonly oracleAnchors: readonly OracleAnchor[]
  /**
   * Optional ε_t early-stop hint. v1 only writes this into the audit
   * log; it does NOT alter the ccbteam main loop (Pure Observer).
   */
  readonly epsilonTarget?: number
}

export type SidecarHandle = {
  /** Idempotent shutdown. */
  stop(): Promise<void>
  /** Cumulative observed CR-EIG bits (R9-1 line 1). */
  totalCrEigBits(): number
  /** Most recent ε_t reading; `null` when no records have been observed. */
  currentEpsilon(): number | null
  /** Render the final `## Information Efficiency` markdown (R9-1). */
  renderInformationEfficiencyMarkdown(): string
}

/* -------------------------------------------------------------------------- */
/* Audit Log Events                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Compact projection of {@link RankedGradient} for the audit log
 * (drops mutable `modelChose` reference, breakdown becomes inline).
 */
export type SerializedRankedGradient = {
  readonly gradient: GradientId
  readonly crEig: number
  readonly breakdown: CrEigBreakdown
  readonly modelChose: boolean
}

export type SidecarAuditEvent =
  | {
      readonly kind: 'session.start'
      readonly sessionId: string
      readonly profileId: string
      readonly weights: CrEigWeights
      readonly timestamp: number
    }
  | {
      readonly kind: 'session.end'
      readonly sessionId: string
      readonly reason: string
      readonly totalCrEig: number
      readonly finalEpsilon: number | null
      readonly timestamp: number
    }
  | {
      readonly kind: 'round.cr-eig'
      readonly sessionId: string
      readonly round: number
      readonly ranking: readonly SerializedRankedGradient[]
      readonly timestamp: number
    }
  | {
      readonly kind: 'round.exploitability'
      readonly sessionId: string
      readonly round: number
      readonly eps: number
      readonly perAgent: Readonly<Record<string, number>>
      readonly timestamp: number
    }
  | {
      readonly kind: 'round.gradient-ranking'
      readonly sessionId: string
      readonly round: number
      readonly modelChose: GradientId | null
      readonly rankedGradient: readonly SerializedRankedGradient[]
      readonly timestamp: number
    }
  | {
      readonly kind: 'round.epistemic'
      readonly sessionId: string
      readonly round: number
      readonly agentId: string
      readonly verdict: EpistemicVerdict
      readonly timestamp: number
    }
  | {
      readonly kind: 'round.epistemic-violation'
      readonly sessionId: string
      readonly round: number
      readonly agentId: string
      readonly ruleId: EpistemicRuleId
      readonly details: string
      readonly timestamp: number
    }
  | {
      readonly kind: 'degradation'
      readonly sessionId: string
      readonly round?: number
      readonly reason: string
      readonly details: string
      readonly timestamp: number
    }

export type AuditWriter = {
  /** Append one event; never throws (failures degrade silently). */
  write(event: SidecarAuditEvent): Promise<void>
  /** Idempotent flush + close. */
  close(): Promise<void>
}

/* -------------------------------------------------------------------------- */
/* Re-export common upstream types so callers don't double-import             */
/* -------------------------------------------------------------------------- */

export type {
  CavReading,
  CavRecord,
  ConsensusState,
  Hypothesis,
  SharedLedger,
  ToolEvidence,
  ToolPlan,
  CcbTeamProfile,
  CcbTeamProfileId,
}

/**
 * Causal Inference Engine — do-calculus style intervention for PEV.
 *
 * DNN only learns correlations ("UPX string present → probably packed").
 * This module enables CAUSAL reasoning: "if we REMOVE the UPX section
 * header, does DiE still report packed?" — the difference between the
 * two runs is the causal effect, not just correlation.
 *
 * Architecture:
 *   - Each ToolPlan can declare an `interventionVariant`: a modified
 *     version of the same plan that changes one variable while holding
 *     others constant.
 *   - The runner executes BOTH the original plan AND the intervention.
 *   - This module compares the two verdicts and produces a
 *     `CausalVerdict` that distinguishes:
 *       - `causal-confirm`: original confirms AND intervention falsifies
 *         (removing the cause removes the effect → true causation)
 *       - `causal-falsify`: original falsifies regardless of intervention
 *       - `correlation-only`: both confirm (the signal persists even
 *         after intervention → it's correlation, not causation)
 *       - `inconclusive`: mixed/unclear results
 *
 * This goes beyond DNN because:
 *   1. DNNs cannot perform interventions (they only observe)
 *   2. DNNs cannot distinguish correlation from causation
 *   3. This implements Pearl's Causal Hierarchy Level 2 (intervention)
 *
 * Hard rules:
 *   - Pure function: same inputs → same outputs.
 *   - No I/O, no LLM calls — just verdict comparison logic.
 *   - The actual tool execution is done by the runner; this module
 *     only provides the comparison logic and intervention plan lookup.
 *
 * Cross-references:
 *   - Pearl, J. (2009). Causality. Cambridge University Press.
 *   - do-calculus: P(Y | do(X)) ≠ P(Y | X) in general
 */

import type { Verdict } from './protocol.js'
import type { ToolPlan } from './canonicalTests.js'
import type { CausalVerdict, SharedLedger } from './ledger.js'

// Re-export CausalVerdict so existing import paths through causalEngine
// keep working. The canonical declaration lives in ledger.ts to break
// what would otherwise be a circular type import.
export type { CausalVerdict } from './ledger.js'

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The causal verdict after comparing original vs intervention runs.
 *
 * This is strictly more informative than a single `Verdict`:
 *   - `causal-confirm`: TRUE causation (intervention breaks the effect)
 *   - `correlation-only`: the signal persists even after intervention
 *     (the hypothesis may be true but for a DIFFERENT reason)
 *   - `causal-falsify`: the hypothesis is false regardless
 *   - `inconclusive`: can't determine causality from these results
 *
 * Note: the canonical type lives in `ledger.ts` (re-exported above) so
 * `ToolEvidence` can carry it as a structural field without a circular
 * type import.
 */

/**
 * Result of a causal comparison between original and intervention runs.
 */
export type CausalResult = {
  readonly causalVerdict: CausalVerdict
  readonly originalVerdict: Verdict
  readonly interventionVerdict: Verdict
  readonly causalStrength: number // [0, 1] — how strong the causal link is
  readonly explanation: string
}

/**
 * An intervention variant of a tool plan. Specifies what to change
 * (the "do" operation) and what to hold constant.
 */
export type InterventionVariant = {
  /** Human-readable description of what the intervention does. */
  readonly description: string
  /**
   * The modified args that constitute the intervention.
   * These override `base_args` in the original plan.
   */
  readonly interventionArgs: Readonly<Record<string, unknown>>
  /**
   * What causal variable is being manipulated.
   * E.g., "remove UPX section header", "zero out TLS directory RVA"
   */
  readonly manipulatedVariable: string
  /**
   * Expected effect if the hypothesis is CAUSALLY true:
   * the intervention should BREAK the confirms pattern.
   */
  readonly expectedEffectIfCausal: 'breaks-confirm' | 'breaks-falsify'
}

/**
 * Extended ToolPlan with optional intervention variant.
 * Plans without an intervention variant can only produce correlational
 * evidence; plans WITH one can produce causal evidence.
 */
export type CausalToolPlan = ToolPlan & {
  readonly interventionVariant?: InterventionVariant
}

/* -------------------------------------------------------------------------- */
/* Intervention Registry                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Registry of intervention variants for canonical plans.
 * Each entry maps a plan id to its intervention specification.
 *
 * Design principle: the intervention should change exactly ONE variable
 * (the suspected cause) while holding everything else constant. If the
 * effect disappears, we have causal evidence. If it persists, we only
 * have correlation.
 */
export const INTERVENTION_REGISTRY: Readonly<Record<string, InterventionVariant>> = {
  'packer::diec': {
    description: 'Run DiE on the binary with UPX section headers zeroed out',
    interventionArgs: { diecArgs: ['-e', '-r', '--no-overlay'] },
    manipulatedVariable: 'UPX section header presence',
    expectedEffectIfCausal: 'breaks-confirm',
  },
  'packer::upx-test': {
    description: 'Run UPX test on a truncated copy (first 1KB only)',
    interventionArgs: { upxArgs: ['-t', '--truncated-probe'] },
    manipulatedVariable: 'complete UPX structure integrity',
    expectedEffectIfCausal: 'breaks-confirm',
  },
  'compiler::dnspy-probe': {
    description: 'Run file command after stripping .NET metadata header',
    interventionArgs: { command: 'file --no-dotnet-heuristic "$TARGET"' },
    manipulatedVariable: '.NET CLI header presence',
    expectedEffectIfCausal: 'breaks-confirm',
  },
  'anti-analysis::strings-grep': {
    description: 'Search for anti-debug APIs in a known-clean reference binary',
    interventionArgs: { command: 'strings /usr/bin/ls | grep -iE "IsDebuggerPresent|NtQueryInformationProcess"' },
    manipulatedVariable: 'target binary (replaced with known-clean)',
    expectedEffectIfCausal: 'breaks-confirm',
  },
  'capability::imports-table': {
    description: 'Dump imports from a statically-linked reference (no DLL imports)',
    interventionArgs: { action: 'imports', targetPath: '$REFERENCE_STATIC' },
    manipulatedVariable: 'dynamic linking (replaced with static binary)',
    expectedEffectIfCausal: 'breaks-confirm',
  },
  'protocol::tshark': {
    description: 'Re-run tshark with TLS SNI field zeroed out to test if protocol detection is causal',
    interventionArgs: { command: 'tshark -r "$CAPTURE" -Y "tls.handshake.extensions_server_name==\"\" "' },
    manipulatedVariable: 'TLS SNI extension presence',
    expectedEffectIfCausal: 'breaks-confirm',
  },
  'protocol::mitm-capture': {
    description: 'Replay flows with a known-legal HTTP request substituted to isolate protocol causation',
    interventionArgs: { command: 'mitmdump -r "$CLEAN_FLOWS" --set console_eventlog_verbosity=info -n' },
    manipulatedVariable: 'request payload (replaced with known-clean)',
    expectedEffectIfCausal: 'breaks-confirm',
  },
  'protocol::strings-protocol-tokens': {
    description: 'Grep for protocol tokens in a known-clean reference binary (no C2 traffic)',
    interventionArgs: { pattern: 'HTTP/(?:1\\.0|1\\.1|2)|gRPC|MQTT|AMQP', targetPath: '$REFERENCE_CLEAN' },
    manipulatedVariable: 'target binary (replaced with known-clean reference)',
    expectedEffectIfCausal: 'breaks-confirm',
  },
} as const

/* -------------------------------------------------------------------------- */
/* Core Functions                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Look up the intervention variant for a given plan id.
 * Returns undefined if no intervention is registered (plan can only
 * produce correlational evidence).
 */
export function getInterventionVariant(planId: string): InterventionVariant | undefined {
  return Object.prototype.hasOwnProperty.call(INTERVENTION_REGISTRY, planId)
    ? INTERVENTION_REGISTRY[planId]
    : undefined
}

/**
 * Determine whether a plan supports causal inference (has an
 * intervention variant registered).
 */
export function supportsCausalInference(planId: string): boolean {
  return getInterventionVariant(planId) !== undefined
}

/**
 * Compare the original verdict with the intervention verdict to
 * produce a causal determination.
 *
 * Truth table (for expectedEffectIfCausal = 'breaks-confirm'):
 *
 * | Original | Intervention | Causal Verdict    | Strength |
 * |----------|-------------|-------------------|----------|
 * | confirms | falsifies   | causal-confirm    | 1.0      |
 * | confirms | inconclusive| causal-confirm    | 0.7      |
 * | confirms | confirms    | correlation-only  | 0.0      |
 * | falsifies| *           | causal-falsify    | 1.0      |
 * | inconclusive | *       | inconclusive      | 0.0      |
 *
 * The key insight: if removing the suspected cause (intervention)
 * also removes the effect (confirms → falsifies), then the
 * relationship is CAUSAL, not merely correlational.
 */
export function compareCausalVerdicts(
  originalVerdict: Verdict,
  interventionVerdict: Verdict,
  variant: InterventionVariant,
): CausalResult {
  // If the original already falsifies, the hypothesis is false
  // regardless of intervention — no causal analysis needed.
  if (originalVerdict === 'falsifies') {
    return {
      causalVerdict: 'causal-falsify',
      originalVerdict,
      interventionVerdict,
      causalStrength: 1.0,
      explanation: `Original run falsifies the hypothesis; intervention is irrelevant.`,
    }
  }

  // If the original is inconclusive, we can't determine causality.
  if (originalVerdict === 'inconclusive' || originalVerdict === 'mutates') {
    return {
      causalVerdict: 'inconclusive',
      originalVerdict,
      interventionVerdict,
      causalStrength: 0,
      explanation: `Original run was inconclusive; cannot determine causal relationship.`,
    }
  }

  // Original confirms. Now check the intervention:
  if (variant.expectedEffectIfCausal === 'breaks-confirm') {
    if (interventionVerdict === 'falsifies') {
      // Perfect causal evidence: removing the cause removes the effect.
      return {
        causalVerdict: 'causal-confirm',
        originalVerdict,
        interventionVerdict,
        causalStrength: 1.0,
        explanation: `Intervention (${variant.manipulatedVariable}) breaks the confirm signal → TRUE causation.`,
      }
    }
    if (interventionVerdict === 'inconclusive' || interventionVerdict === 'mutates') {
      // Partial causal evidence: intervention weakens but doesn't
      // fully break the signal.
      return {
        causalVerdict: 'causal-confirm',
        originalVerdict,
        interventionVerdict,
        causalStrength: 0.7,
        explanation: `Intervention weakens the signal (${variant.manipulatedVariable}) → likely causal (strength 0.7).`,
      }
    }
    if (interventionVerdict === 'confirms') {
      // The signal persists even after intervention — this is
      // CORRELATION, not causation. The hypothesis might still be
      // true, but for a different reason than we thought.
      return {
        causalVerdict: 'correlation-only',
        originalVerdict,
        interventionVerdict,
        causalStrength: 0,
        explanation: `Signal persists after intervention (${variant.manipulatedVariable}) → correlation only, not causation.`,
      }
    }
  }

  // Fallback for unexpected combinations.
  return {
    causalVerdict: 'inconclusive',
    originalVerdict,
    interventionVerdict,
    causalStrength: 0,
    explanation: `Unexpected verdict combination; cannot determine causality.`,
  }
}

/**
 * Compute the EIG boost for a plan that supports causal inference.
 *
 * Pearl's Causal Hierarchy Level 2 says interventional information is
 * strictly more valuable than associational information — but ONLY
 * when interventions actually distinguish causation from correlation.
 * A plan that has an intervention variant in the registry but, when
 * historically applied, has yielded mostly `correlation-only` results
 * is in practice no more informative than a vanilla correlational run.
 *
 * Algorithm:
 *   1. Plans NOT in the intervention registry → `baseEig` unchanged.
 *   2. Plans in the registry with NO historical intervention evidence
 *      yet → optimistic boost of 1.5× (we don't know better; trust the
 *      registry author's intent).
 *   3. Plans with ≥ 1 historical intervention evidence rows → boost is
 *      linearly interpolated between 1.0× and 1.5× based on the
 *      observed `causalFraction = causal-confirm count / total`:
 *        boost = 1.0 + 0.5 × causalFraction
 *      i.e. a plan that has been 100% causal in history gets 1.5×, a
 *      plan that has been 0% causal (always `correlation-only`) gets
 *      1.0× (no boost), and intermediate ratios scale linearly.
 *
 * Backward compatibility: when called without `ledger` (legacy 2-arg
 * signature), falls back to the old static 1.5× behaviour for any
 * registered plan. This keeps existing tests + downstream callers
 * working until they migrate.
 *
 * @param baseEig The EIG computed by eigEngine.ts for the original plan
 * @param planId  The plan id to check for causal support
 * @param ledger  Optional ledger snapshot for history-aware boost
 * @returns Boosted EIG (in [baseEig, baseEig × 1.5])
 */
export function applyCausalBoost(
  baseEig: number,
  planId: string,
  ledger?: SharedLedger,
): number {
  if (!supportsCausalInference(planId)) return baseEig

  // Legacy / no-history path: trust the registry, full boost.
  if (!ledger) return baseEig * 1.5

  // Scan the evidence log for past intervention rows of this plan.
  let causalConfirmCount = 0
  let totalInterventionCount = 0
  for (const ev of ledger.evidenceLog) {
    if (!ev.isCausalIntervention) continue
    if (ev.planId !== planId) continue
    totalInterventionCount += 1
    if (ev.causalVerdict === 'causal-confirm') {
      causalConfirmCount += 1
    }
  }

  // No history → optimistic full boost (same as legacy path).
  if (totalInterventionCount === 0) return baseEig * 1.5

  // History exists → boost scales with the empirical causal fraction.
  const causalFraction = causalConfirmCount / totalInterventionCount
  const multiplier = 1.0 + 0.5 * causalFraction
  return baseEig * multiplier
}

/**
 * Given a hypothesis and its evidence trail, determine the overall
 * causal confidence — what fraction of the evidence is CAUSAL vs
 * merely correlational.
 *
 * This is used by the final summary to report how much of the
 * conclusion is backed by causal evidence vs correlation.
 */
export function computeCausalConfidence(
  causalResults: readonly CausalResult[],
): { causalFraction: number; avgStrength: number } {
  if (causalResults.length === 0) {
    return { causalFraction: 0, avgStrength: 0 }
  }

  const causalCount = causalResults.filter(
    r => r.causalVerdict === 'causal-confirm',
  ).length
  const totalStrength = causalResults.reduce(
    (sum, r) => sum + r.causalStrength,
    0,
  )

  return {
    causalFraction: causalCount / causalResults.length,
    avgStrength: totalStrength / causalResults.length,
  }
}

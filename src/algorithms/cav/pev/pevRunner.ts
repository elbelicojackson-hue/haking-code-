/**
 * PevRunner — Plan-Execute-Verify main loop (Component 9 / Algorithm 5).
 *
 * This module is the **orchestration core** of the PEV layer. Every other
 * file under `src/services/cav/pev/` is a pure leaf:
 *
 *   - protocol.ts       defines the wire format
 *   - ledger.ts         is a pure reducer over hypothesis + evidence state
 *   - canonicalTests.ts is a const table of allowed tool plans
 *   - parser.ts         turns raw LLM markdown into a validated PevOutput
 *   - validator.ts      enforces referential integrity
 *   - verdict.ts        regex-judges tool stdout
 *   - scheduler.ts      assigns per-agent directives
 *   - propagator.ts     builds per-agent inboxes
 *   - promptBuilder.ts  serialises everything to two prompt strings
 *
 * `runPev` is what stitches them together into a deterministic `for round`
 * loop, yielding {@link PevRoundEvent}s the UI layer (T13) and persistence
 * layer (T11) consume. The runner itself owns NO domain state beyond the
 * ledger snapshot it threads through every step.
 *
 * Hard rules (audited):
 *   - **Single-source-of-truth ledger**: every state mutation is a pure
 *     reducer call (`applyHypothesisUpdate`, `appendEvidence`,
 *     `applyStaleCascade`, `decrementBudget`, `incrementParseStats`).
 *     The runner threads the new ledger between steps; nothing else
 *     ever observes a mid-update snapshot.
 *   - **Deterministic agent-order for updates** (R10-5): scheduler /
 *     propagator / dispatch run in `agents`-array order, parses
 *     similarly, and `applyHypothesisUpdate` is applied in that same
 *     order so two re-runs against the same fixtures produce identical
 *     ledgers.
 *   - **Errors never crash the loop** (R10-9): every provider /
 *     tool / parser failure is caught and surfaced as an event; the
 *     runner emits `run-end` rather than throwing.
 *   - **Type-only `ArenaProvider` import** (R13-1): the runner does
 *     NOT pull `dispatcher.ts` runtime symbols. Real wiring lives in
 *     ccb-pev.tsx (T12) which is responsible for converting the
 *     existing `dispatchArena` into a per-provider adapter.
 *   - **Secrets redaction** (R5-8 / R6 evidence): tool args are
 *     scrubbed with {@link redactSecrets} before they ever touch the
 *     ledger so a stray `apiKey: "sk-..."` in `args_override` never
 *     gets persisted to `<sessionId>.pev.json`.
 *
 * Cross-references:
 *   - .kiro/specs/ccb-pev-re-execution-loop/design.md → Component 9 /
 *     Algorithm 5 / Sequence Diagram 1
 *   - .kiro/specs/ccb-pev-re-execution-loop/requirements.md → R10-1 ..
 *     R10-9, R5-6, R7-3, R7-7
 */

import {
  findToolPlan,
  type ToolPlan,
} from './canonicalTests.js'
import {
  appendEvidence,
  applyHypothesisUpdate,
  applyStaleCascade,
  createEmptyLedger,
  decrementBudget,
  incrementParseStats,
  type Hypothesis,
  type SharedLedger,
} from './ledger.js'
import { parsePevOutput, type ParseResult } from './parser.js'
import type {
  PevOutput,
  Verdict,
} from './protocol.js'
import {
  buildAgentSystemPrompt,
  buildAgentUserPrompt,
} from './promptBuilder.js'
import { propagate } from './propagator.js'
import {
  schedule,
  type AgentDescriptor,
  type PevBudget,
  type ScheduleDirective,
} from './scheduler.js'
import type {
  LedgerView,
  ValidatorContext,
} from './validator.js'
import { judgeVerdict } from './verdict.js'
import {
  compareCausalVerdicts,
  getInterventionVariant,
  supportsCausalInference,
  type CausalResult,
} from './causalEngine.js'

import type { ArenaProvider } from '../arena/providers.js'

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Outcome of one provider-adapter call. Kept narrow on purpose — the runner
 * only consumes the assistant text. Token usage / oracle bundles are the
 * adapter's concern (and live on `ArenaResponse` upstream).
 */
export type ProviderAdapterResult = {
  readonly content: string
}

/**
 * Outcome of one tool-adapter call. Mirrors the fields the canonical
 * `judgeVerdict` engine consumes plus a `durationMs` for the evidence log.
 */
export type ToolAdapterResult = {
  readonly stdout: string
  readonly exitCode: number
  readonly durationMs: number
}

/**
 * Entry-point opts. Most fields are required at runtime; `providerAdapter`
 * and `toolAdapter` are optional **only at the type level** so unit tests
 * can drop them in via a single object literal — at runtime, the runner
 * yields a `run-end` event with `reason: 'budget-cap-hit'` if the
 * adapters are missing (rather than throwing).
 */
export type PevRunOpts = {
  /** Enabled providers (length ≥ 1). The runner derives an
   * {@link AgentDescriptor} per provider using `provider.id`. */
  readonly providers: readonly ArenaProvider[]
  /** Target binary metadata. Embedded into the system prompt for
   * audit; the runner itself does no I/O against the binary. */
  readonly targetBinary: {
    readonly path: string
    readonly sha256: string
    readonly size: number
  }
  /** User's natural-language goal — embedded in every system prompt. */
  readonly initialClaim: string
  /** 4-dimension budget (rounds / tools / tokens / wall-clock). */
  readonly budget: PevBudget
  /** Optional abort signal (Esc-to-cancel from the UI layer). */
  readonly signal?: AbortSignal
  /**
   * Per-provider LLM call. Production wiring lives in ccb-pev.tsx
   * (T12) which translates `dispatchArena` to this shape. Tests
   * inject a canned-response stub.
   */
  readonly providerAdapter?: (
    provider: ArenaProvider,
    systemPrompt: string,
    userPrompt: string,
    signal: AbortSignal,
  ) => Promise<ProviderAdapterResult>
  /**
   * Tool execution callback. Production wiring lives in T13/T14 which
   * routes to `ReverseCli` / `Bash` / etc. via the existing tool layer.
   * Tests inject a canned-stdout stub.
   */
  readonly toolAdapter?: (
    plan: ToolPlan,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<ToolAdapterResult>
  /**
   * Optional persistence callback (T11). Invoked once after every
   * round-end with the latest ledger snapshot. Failures here are
   * downgraded to a `console.debug` log — persistence MUST NOT
   * crash the loop (R6-7).
   */
  readonly onPersist?: (ledger: SharedLedger, round: number) => Promise<void>
  /** Layer-3 retry cap inside the parser. Defaults to 1 (R5-3). */
  readonly maxParseRetries?: number
  /**
   * Cap on inbox items per agent (propagator). Currently propagator
   * applies its own cap of 5; this field is wired through for future
   * tunability and runner-side audit.
   */
  readonly maxInboxItemsPerAgent?: number
  /**
   * Parse-storm threshold (R5-6). Default 0.5 — when ≥ half the agents
   * fail to parse in a single round, the runner stops with reason
   * `'parse-storm'`.
   */
  readonly maxFailRatePerRound?: number
  /**
   * Number of consecutive stall rounds before stopping with reason
   * `'stall-guard-hit'` (R7-7). Default 2.
   */
  readonly stallGuardConsecutive?: number
  /**
   * Enable the read-only web dashboard server (FR-1). When true, the
   * runner dynamically imports and starts an HTTP server on
   * `127.0.0.1:<port>` and pushes every PevRoundEvent to connected
   * browser tabs via SSE. The URL is printed to stderr at startup.
   *
   * Failures during dashboard startup (port busy, etc.) are logged at
   * debug level and the run continues without dashboard (NFR-5).
   *
   * Default `false`: tests do not start a server. Production callers
   * (`ccb-pev.tsx` / `ccb-arena.tsx`) opt in.
   */
  readonly enableDashboard?: boolean
}

/** Reason the loop terminated. Surfaced to the UI for the final summary. */
export type StopReason =
  | 'all-resolved'
  | 'budget-cap-hit'
  | 'stall-guard-hit'
  | 'parse-storm'
  | 'user-abort'

/**
 * The 7 round-event kinds the runner yields. UI / persistence consume
 * these via `for await (const ev of runPev(opts))`.
 */
export type PevRoundEvent =
  | { kind: 'round-start'; round: number }
  | {
      kind: 'agent-output'
      agentId: string
      round: number
      parseResult: ParseResult
    }
  | { kind: 'ledger-update'; ledger: SharedLedger }
  | {
      kind: 'tool-call-start'
      agentId: string
      planId: string
      round: number
    }
  | {
      kind: 'tool-call-complete'
      agentId: string
      planId: string
      verdict: Verdict
      round: number
    }
  | { kind: 'round-end'; round: number; ledger: SharedLedger }
  | {
      kind: 'run-end'
      reason: StopReason
      finalLedger: SharedLedger
      detail?: string
    }

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Length cap for `resultDigest` (R6-3). Head 400 + tail 100 = ≤ 500. */
const DIGEST_HEAD = 400
const DIGEST_TAIL = 100
const DIGEST_LIMIT = DIGEST_HEAD + DIGEST_TAIL

/** Defaults — declared once so docs + DoD-checks see the same values. */
const DEFAULT_MAX_FAIL_RATE = 0.5
const DEFAULT_STALL_CONSECUTIVE = 2

/**
 * Regex that flags a tool-arg key as "secret-shaped" for {@link redactSecrets}.
 * Mirrors the dispatcher.ts intent (T13/R5-8) but operates on object KEYS,
 * not on body text — `dispatcher.redactSecrets` redacts substrings, this
 * helper redacts whole values whose key looks sensitive.
 */
const SECRET_KEY_RE = /api[_-]?key|token|authorization|bearer|password|secret/i

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Recursively replace every value under a "secret-shaped" key with `'***'`.
 * Pure / non-mutating; returns a new object tree. Arrays are walked,
 * primitives at non-secret keys pass through.
 *
 * Why a new function rather than reusing dispatcher.redactSecrets:
 *   - dispatcher's helper redacts substrings inside a single string (for
 *     log-line scrubbing). The runner needs structural redaction over
 *     `toolArgs: unknown` BEFORE that object is JSON-serialised into the
 *     ledger. The two operate at different abstraction levels.
 */
export function redactSecrets(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(v => redactSecrets(v))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_RE.test(k)) {
        out[k] = '***'
      } else {
        out[k] = redactSecrets(v)
      }
    }
    return out
  }
  return value
}

/**
 * Merge `plan.base_args` with the agent-supplied `args_override`,
 * filtering the override keys to those allow-listed by the plan.
 *
 * Validator (T2) already rejects invalid override keys, so the filter is
 * defence-in-depth: if the validator was somehow bypassed (e.g. `findToolPlan`
 * was not injected), unknown keys silently drop here rather than reaching
 * the tool. We accept `null` as the override (canonical "use plan defaults").
 */
export function mergeArgs(
  base: Readonly<Record<string, unknown>>,
  override: Readonly<Record<string, unknown>> | null | undefined,
  allow: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  if (!override) return out
  const allowSet = new Set(allow)
  for (const [k, v] of Object.entries(override)) {
    if (allowSet.has(k)) out[k] = v
  }
  return out
}

/**
 * Compress `stdout` into a length-bounded digest (≤ 500 chars). The head
 * is the most signal-dense (banners, first match line); the tail
 * preserves any trailing summary or non-zero exit annotation. The
 * separator clearly marks the cut so audit readers can tell.
 */
export function digestStdout(stdout: string): string {
  if (stdout.length <= DIGEST_LIMIT) return stdout
  return `${stdout.slice(0, DIGEST_HEAD)}\n…\n${stdout.slice(-DIGEST_TAIL)}`
}

/**
 * Map an agent id + parse-layer hit / failure into the corresponding
 * `parseStats` counter to bump on the ledger. Centralised so a future
 * counter rename is a one-file change.
 */
function parseStatsKindForResult(
  result: ParseResult,
): 'layer1' | 'layer2' | 'layer3' | 'failure' {
  if (!result.ok) return 'failure'
  if (result.layerHit === 1) return 'layer1'
  if (result.layerHit === 2) return 'layer2'
  return 'layer3'
}

/**
 * Build the structural `LedgerView` the validator expects from the live
 * `SharedLedger`. Already structurally compatible; the helper exists
 * purely as documentation that the validator only reads `id`, `status`,
 * `confidence`, and `evidenceLog[*].id`.
 */
function asLedgerView(ledger: SharedLedger): LedgerView {
  return ledger
}

/**
 * Map `(exitCode)` → `ToolEvidence['outcome']` per Algorithm 5. Note: a
 * `-1` exit (used by the runner for tool-adapter throws / aborts) maps
 * to `'failure'`; non-zero positive maps to `'inconclusive'` (the tool
 * ran, signalled an error, but its stdout may still be informative).
 */
function outcomeForExitCode(
  exitCode: number,
): 'success' | 'failure' | 'inconclusive' {
  if (exitCode === 0) return 'success'
  if (exitCode === -1) return 'failure'
  return 'inconclusive'
}

/**
 * Iterate the agent list to derive {@link AgentDescriptor}s. We omit the
 * `kind` field (scheduler doesn't consult it today) — leaving it
 * undefined keeps the descriptor minimal and easy to compare in tests.
 */
function deriveAgentDescriptors(
  providers: readonly ArenaProvider[],
): readonly AgentDescriptor[] {
  return providers.map(p => ({ id: p.id }))
}

/**
 * Pre-compute the system prompt for every agent once at run-start. The
 * system prompt is stable across rounds (only the user prompt evolves),
 * so doing this work N times instead of N×rounds saves measurable
 * latency on long sessions.
 */
function precomputeSystemPrompts(
  providers: readonly ArenaProvider[],
  initialClaim: string,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const p of providers) {
    out.set(
      p.id,
      buildAgentSystemPrompt({
        agentId: p.id,
        initialClaim,
      }),
    )
  }
  return out
}

/**
 * Are there any `open` hypotheses left? When all hypotheses are in a
 * terminal state (`evidence` / `falsified` / `mutated` / `stale`), the
 * loop stops with reason `'all-resolved'` (R10-4 a).
 *
 * Note: design.md Algorithm 5 phrases this as `filter(status ∈ {open,
 * evidence}).length === 0`. We follow the requirements / task wording
 * (no `open`) instead — this is the user-visible contract, and an
 * `evidence` state is a positive terminal that does NOT need further
 * rounds.
 */
function hasOpenHypothesis(ledger: SharedLedger): boolean {
  for (const h of ledger.hypotheses.values()) {
    if (h.status === 'open') return true
  }
  return false
}

/* -------------------------------------------------------------------------- */
/* Internal: dispatch one agent (LLM call + parse + retry)                    */
/* -------------------------------------------------------------------------- */

/**
 * Per-agent dispatch + parse. Returns the parse result. Provider failures
 * are caught and surfaced as a parse failure with `errorKind:
 * 'json-parse-failed'` so the loop continues for healthy peers. The
 * runner is responsible for bumping `parseStats` on the ledger in
 * deterministic agent-order; this helper does NOT mutate the ledger.
 */
async function dispatchAndParseAgent(args: {
  readonly provider: ArenaProvider
  readonly round: number
  readonly systemPrompt: string
  readonly userPrompt: string
  readonly ledger: SharedLedger
  readonly providerAdapter: NonNullable<PevRunOpts['providerAdapter']>
  readonly signal: AbortSignal
}): Promise<ParseResult> {
  const { provider, round, systemPrompt, userPrompt, ledger, providerAdapter, signal } = args

  // First call.
  let firstContent: string
  try {
    const r = await providerAdapter(provider, systemPrompt, userPrompt, signal)
    firstContent = r.content ?? ''
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      errorKind: 'json-parse-failed',
      detail: `provider call failed: ${detail}`,
    }
  }

  // Layer-3 retry callback. The parser will invoke it AT MOST ONCE
  // (R5-3) and only if Layer 1 + Layer 2 both failed. We re-issue the
  // same provider call with the original system + user prompt PLUS the
  // parser-supplied feedback appended to the user side. Errors here are
  // caught inside the parser and reported as `retry-exhausted`.
  const ctx: ValidatorContext = {
    selfAgentId: provider.id,
    round,
    ledger: asLedgerView(ledger),
    findToolPlan,
  }
  const retryFn = async (feedback: string): Promise<string> => {
    const augmentedUser = `${userPrompt}\n\n---\n\n${feedback}`
    const r = await providerAdapter(provider, systemPrompt, augmentedUser, signal)
    return r.content ?? ''
  }

  return parsePevOutput(firstContent, ctx, retryFn)
}

/* -------------------------------------------------------------------------- */
/* Internal: execute one tool_call from a parsed PevOutput                    */
/* -------------------------------------------------------------------------- */

/**
 * Yield-tuple from {@link executeToolCall}. We hand events back to the
 * runner so it can interleave them with `agent-output` / `ledger-update`
 * in the canonical order. Returns the new ledger and a list of events
 * that were generated for THIS tool call.
 */
type ToolCallOutcome = {
  readonly events: readonly PevRoundEvent[]
  readonly ledger: SharedLedger
}

async function executeToolCall(args: {
  readonly agentId: string
  readonly round: number
  readonly action: Extract<PevOutput['next_action'], { kind: 'tool_call' }>
  readonly ledger: SharedLedger
  readonly toolAdapter: NonNullable<PevRunOpts['toolAdapter']>
  readonly signal: AbortSignal
}): Promise<ToolCallOutcome> {
  const { agentId, round, action, ledger, toolAdapter, signal } = args
  const events: PevRoundEvent[] = []

  const plan = findToolPlan(action.tool_plan_id)
  if (!plan) {
    // Validator should have caught this; defence-in-depth no-op.
    console.debug(
      `[pev/runner] skip tool_call: plan="${action.tool_plan_id}" not found`,
    )
    return { events, ledger }
  }

  // Re-check the targeted hypothesis is still tractable. The scheduler
  // may have left a tool_call queued in the same round when the parent
  // got falsified earlier in the same parse-pass (R7-5: in-flight
  // tolerated, but we never KICK OFF a fresh call against a dead H).
  const targetH: Hypothesis | undefined = ledger.hypotheses.get(
    action.hypothesis_id,
  )
  if (!targetH) {
    console.debug(
      `[pev/runner] skip tool_call: hypothesis="${action.hypothesis_id}" not in ledger`,
    )
    return { events, ledger }
  }
  if (targetH.status === 'stale' || targetH.status === 'falsified' || targetH.status === 'mutated') {
    console.debug(
      `[pev/runner] skip tool_call: hypothesis="${action.hypothesis_id}" status="${targetH.status}"`,
    )
    return { events, ledger }
  }

  // Merge args + redact. Both happen BEFORE tool invocation so a
  // misconfigured tool can't leak a secret through its own logging
  // (the redacted view is also what we record into the ledger).
  const mergedArgs = mergeArgs(
    plan.base_args,
    action.args_override ?? null,
    plan.overridable_fields,
  )
  const redactedArgs = redactSecrets(mergedArgs) as Record<string, unknown>

  events.push({
    kind: 'tool-call-start',
    agentId,
    planId: plan.id,
    round,
  })

  // Tool exec — adapter is responsible for honouring `plan.timeout_ms`
  // and the abort signal. On exception, we still record evidence so
  // the agent knows the call was attempted.
  let stdout = ''
  let exitCode = -1
  let durationMs = 0
  try {
    const result = await toolAdapter(plan, mergedArgs, signal)
    stdout = result.stdout
    exitCode = result.exitCode
    durationMs = result.durationMs
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.debug(`[pev/runner] tool adapter threw: ${msg}`)
    // Keep defaults: stdout='', exitCode=-1.
  }

  // Verdict + evidence append. `appendEvidence` mints `E<n>` and
  // updates the targeted H's evidenceTrail.
  const verdict = judgeVerdict(plan, stdout, exitCode)
  const append = appendEvidence(ledger, {
    agentId,
    round,
    toolName: plan.tool,
    toolArgs: redactedArgs,
    outcome: outcomeForExitCode(exitCode),
    resultDigest: digestStdout(stdout),
    testedHypothesis: action.hypothesis_id,
    verdict: verdict.verdict,
    durationMs,
    planId: plan.id,
  })
  let nextLedger = append.ledger
  // R6-1 budget bookkeeping — every executed tool_call consumes one slot.
  nextLedger = decrementBudget(nextLedger, 1)

  events.push({
    kind: 'tool-call-complete',
    agentId,
    planId: plan.id,
    verdict: verdict.verdict,
    round,
  })

  // --- Causal intervention branch ---
  // When the plan supports causal inference, run the intervention variant
  // and compare verdicts to distinguish causation from correlation.
  // This implements Pearl's do-calculus Level 2: P(Y | do(X)) ≠ P(Y | X).
  const interventionVariant = getInterventionVariant(plan.id)
  if (interventionVariant && verdict.verdict === 'confirms') {
    // Only run intervention when the original confirms — if it already
    // falsifies, causal analysis is unnecessary (causal-falsify is trivial).
    let interventionStdout = ''
    let interventionExitCode = -1
    let interventionDurationMs = 0
    try {
      // Build intervention args: merge the intervention overrides on top
      // of the original merged args.
      const interventionMerged = {
        ...mergedArgs,
        ...interventionVariant.interventionArgs,
      }
      const result = await toolAdapter(plan, interventionMerged, signal)
      interventionStdout = result.stdout
      interventionExitCode = result.exitCode
      interventionDurationMs = result.durationMs
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.debug(`[pev/runner] causal intervention threw: ${msg}`)
    }

    // Judge the intervention verdict using the same plan's regex patterns.
    const interventionVerdict = judgeVerdict(plan, interventionStdout, interventionExitCode)

    // Compare original vs intervention to produce a CausalResult.
    const causalResult: CausalResult = compareCausalVerdicts(
      verdict.verdict,
      interventionVerdict.verdict,
      interventionVariant,
    )

    // Record the intervention as a second evidence entry. Causal
    // metadata is now first-class structured data on the evidence row
    // (planId, isCausalIntervention, causalVerdict, causalStrength,
    // manipulatedVariable) — agents and the scheduler should read these
    // fields rather than parsing the digest string. The `[CAUSAL ...]`
    // prefix in the digest is preserved purely for human-readable audit.
    const causalDigest = `[CAUSAL ${causalResult.causalVerdict} (strength=${causalResult.causalStrength})] ` +
      `intervention: ${interventionVariant.manipulatedVariable}\n` +
      digestStdout(interventionStdout)

    const interventionAppend = appendEvidence(nextLedger, {
      agentId,
      round,
      toolName: plan.tool,
      toolArgs: redactSecrets({
        ...mergedArgs,
        ...interventionVariant.interventionArgs,
      }) as Record<string, unknown>,
      outcome: outcomeForExitCode(interventionExitCode),
      resultDigest: causalDigest,
      testedHypothesis: action.hypothesis_id,
      verdict: interventionVerdict.verdict,
      durationMs: interventionDurationMs,
      planId: plan.id,
      isCausalIntervention: true,
      causalVerdict: causalResult.causalVerdict,
      causalStrength: causalResult.causalStrength,
      manipulatedVariable: interventionVariant.manipulatedVariable,
    })
    nextLedger = interventionAppend.ledger
    // Intervention also consumes a budget slot.
    nextLedger = decrementBudget(nextLedger, 1)
  }

  return { events, ledger: nextLedger }
}

/* -------------------------------------------------------------------------- */
/* Public: runPev — the main async-generator loop                             */
/* -------------------------------------------------------------------------- */

/**
 * Drive the PEV loop end-to-end and yield events as they happen.
 *
 * Algorithm 5 (mirrors design.md verbatim):
 *   1. yield `round-start`
 *   2. scheduler → per-agent directive + stallGuardWarning
 *   3. propagator → per-agent inbox
 *   4. for each provider in parallel: build prompt, call adapter, parse
 *      with optional retry → yield `agent-output`
 *   5. parse-storm check (≥ maxFailRatePerRound failed)
 *   6. apply HypothesisUpdates in deterministic agent-order; trigger
 *      `applyStaleCascade` on `falsify`
 *   7. yield `ledger-update`
 *   8. execute tool_calls in deterministic agent-order; for each: yield
 *      `tool-call-start`, append evidence, yield `tool-call-complete`
 *   9. yield `ledger-update` (post-tool snapshot)
 *  10. optional persistence callback
 *  11. yield `round-end`
 *  12. stop conditions: all-resolved | budget-cap | stall-guard |
 *      parse-storm | user-abort
 *
 * Errors at any step are caught and either surfaced as a `parseResult.ok=false`
 * event or absorbed silently — the runner NEVER throws to its caller.
 */
/**
 * Internal core generator — implements the PEV loop.
 *
 * Public callers use {@link runPev} instead, which wraps this with the
 * optional dashboard mirror. Tests and direct consumers may still use
 * `runPev` directly; the wrapper is transparent when `enableDashboard`
 * is false (it just forwards events 1:1).
 */
async function* runPevCore(
  opts: PevRunOpts,
): AsyncGenerator<PevRoundEvent, void, void> {
  // Resolve options + defaults up-front so we don't repeat the
  // nullish-coalesce in the hot loop.
  const providers = opts.providers
  const budget = opts.budget
  const maxFailRate = opts.maxFailRatePerRound ?? DEFAULT_MAX_FAIL_RATE
  const stallGuardLimit =
    opts.stallGuardConsecutive ?? DEFAULT_STALL_CONSECUTIVE
  const externalSignal = opts.signal
  const providerAdapter = opts.providerAdapter
  const toolAdapter = opts.toolAdapter

  // Initial state.
  let ledger = createEmptyLedger(budget.maxToolCalls)
  const startTime = Date.now()

  // Bail-out: missing adapters. The runner contract says we never
  // throw; emit a single `run-end` and return.
  if (!providerAdapter) {
    yield {
      kind: 'run-end',
      reason: 'budget-cap-hit',
      finalLedger: ledger,
      detail: 'providerAdapter not provided; runner cannot dispatch agents',
    }
    return
  }
  if (!toolAdapter) {
    // toolAdapter absence is non-fatal: rounds with `observe_only` next
    // actions can still progress. We log once and substitute a stub
    // that always returns inconclusive output. Tests / production can
    // still inject a real one.
    console.debug(
      '[pev/runner] toolAdapter not provided; tool_calls will return inconclusive stubs',
    )
  }
  const effectiveToolAdapter: NonNullable<PevRunOpts['toolAdapter']> =
    toolAdapter ??
    (async () => ({
      stdout: '[pev/runner] no toolAdapter configured; treat as inconclusive',
      exitCode: 1,
      durationMs: 0,
    }))

  const agents = deriveAgentDescriptors(providers)
  const systemPrompts = precomputeSystemPrompts(providers, opts.initialClaim)

  // Stall-guard counter persists across rounds.
  let consecutiveStallRounds = 0

  // The signal threaded into adapters. Construct a never-aborting
  // controller when the caller didn't pass one — adapters demand a
  // real `AbortSignal` object.
  const internalController = new AbortController()
  const effectiveSignal: AbortSignal = externalSignal ?? internalController.signal

  // Helper: did the user (or the dispatcher) abort?
  const isAborted = (): boolean => effectiveSignal.aborted

  // Helper: is wall-clock budget blown?
  const isWallClockBlown = (): boolean =>
    Date.now() - startTime >= budget.maxWallClockMs

  // ----- Main round loop ----------------------------------------------------
  for (let round = 0; round < budget.maxRounds; round += 1) {
    // Early abort check at the top of every round.
    if (isAborted()) {
      yield {
        kind: 'run-end',
        reason: 'user-abort',
        finalLedger: ledger,
        detail: 'aborted before round start',
      }
      return
    }

    yield { kind: 'round-start', round }

    // -- Step 1: scheduler ------------------------------------------------
    const schedResult = schedule(ledger, agents, round, budget)
    if (schedResult.stallGuardWarning) {
      consecutiveStallRounds += 1
      if (consecutiveStallRounds >= stallGuardLimit) {
        yield {
          kind: 'run-end',
          reason: 'stall-guard-hit',
          finalLedger: ledger,
          detail: `${consecutiveStallRounds} consecutive observer-only rounds`,
        }
        return
      }
    } else {
      consecutiveStallRounds = 0
    }

    // -- Step 2: propagator -----------------------------------------------
    const propResult = propagate(ledger, agents, round)

    // -- Step 3: dispatch all providers in parallel + parse ---------------
    // We run the per-agent dispatch in parallel for latency, then merge
    // each agent's parseStats bump back into the ledger sequentially in
    // the canonical agent-order. This preserves determinism (parseStats
    // is order-sensitive: hypothesis_updates are applied later in the
    // same order).
    type DispatchOutcome = {
      provider: ArenaProvider
      directive: ScheduleDirective | undefined
      parseResult: ParseResult
      // The parsed ParseResult-side ledger update we have to merge
      // back. We snapshotted the ledger on dispatch start, so we
      // recompute the parseStats bump locally rather than threading
      // multi-writer state through Promise.all.
      parseStatsKind: 'layer1' | 'layer2' | 'layer3' | 'failure'
    }
    const dispatchPromises: Promise<DispatchOutcome>[] = providers.map(
      async provider => {
        const directive = schedResult.perAgentDirective.get(provider.id)
        const inbox = propResult.perAgentInbox.get(provider.id)
        const userPrompt = buildAgentUserPrompt({
          agentId: provider.id,
          round,
          directive,
          inbox,
          ledger,
        })
        const systemPrompt = systemPrompts.get(provider.id) ??
          buildAgentSystemPrompt({
            agentId: provider.id,
            initialClaim: opts.initialClaim,
          })

        const parseResult = await dispatchAndParseAgent({
          provider,
          round,
          systemPrompt,
          userPrompt,
          ledger,
          providerAdapter,
          signal: effectiveSignal,
        })
        return {
          provider,
          directive,
          parseResult,
          parseStatsKind: parseStatsKindForResult(parseResult),
        }
      },
    )
    const dispatchOutcomes = await Promise.all(dispatchPromises)

    // Bump parseStats in agent-order so the ledger evolution is
    // reproducible across runs with the same fixtures.
    for (const out of dispatchOutcomes) {
      ledger = incrementParseStats(ledger, out.parseStatsKind)
      yield {
        kind: 'agent-output',
        agentId: out.provider.id,
        round,
        parseResult: out.parseResult,
      }
    }

    // -- Step 4: parse-storm check ---------------------------------------
    if (providers.length > 0) {
      let failedCount = 0
      for (const out of dispatchOutcomes) {
        if (!out.parseResult.ok) failedCount += 1
      }
      const rate = failedCount / providers.length
      if (rate >= maxFailRate) {
        yield {
          kind: 'run-end',
          reason: 'parse-storm',
          finalLedger: ledger,
          detail: `${failedCount}/${providers.length} agents failed to parse`,
        }
        return
      }
    }

    // -- Step 5: apply hypothesis updates --------------------------------
    // Iterate in `providers`-array order so the same fixtures always
    // produce the same final ledger. Within one agent, updates are
    // applied in array order (the order the agent emitted them).
    for (const out of dispatchOutcomes) {
      if (!out.parseResult.ok) continue
      const parsed = out.parseResult.parsed
      for (const update of parsed.hypothesis_updates) {
        ledger = applyHypothesisUpdate(ledger, update, out.provider.id, round)
        if (update.op === 'falsify') {
          // Cascade marks descendants `stale` (R7-3 / R7-8). We DO NOT
          // cascade on `mutate` per design.md Algorithm 5 — the old H
          // is marked `mutated` directly by the reducer, and the
          // descendants are still relevant to the new H subtree.
          ledger = applyStaleCascade(ledger, update.id)
        }
      }
    }

    yield { kind: 'ledger-update', ledger }

    // -- Step 6: execute tool_calls --------------------------------------
    for (const out of dispatchOutcomes) {
      if (!out.parseResult.ok) continue
      const parsed = out.parseResult.parsed
      const action = parsed.next_action
      if (action.kind !== 'tool_call') continue

      // Skip if budget already blown (defence-in-depth — the loop also
      // checks at the bottom).
      if (ledger.toolBudgetRemaining <= 0) {
        console.debug(
          `[pev/runner] skip tool_call for ${out.provider.id}: budget remaining=0`,
        )
        continue
      }

      const callOutcome = await executeToolCall({
        agentId: out.provider.id,
        round,
        action,
        ledger,
        toolAdapter: effectiveToolAdapter,
        signal: effectiveSignal,
      })
      ledger = callOutcome.ledger
      for (const ev of callOutcome.events) {
        yield ev
      }
    }

    // Snapshot the post-tool ledger for the UI (separate from the
    // pre-tool snapshot at step 5).
    yield { kind: 'ledger-update', ledger }

    // -- Step 7: persistence callback ------------------------------------
    if (opts.onPersist) {
      try {
        await opts.onPersist(ledger, round)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.debug(`[pev/runner] onPersist threw at round ${round}: ${msg}`)
      }
    }

    // -- Step 8: round-end + stop-condition check ------------------------
    yield { kind: 'round-end', round, ledger }

    // (a) all-resolved (no `open` H)
    if (!hasOpenHypothesis(ledger) && ledger.hypotheses.size > 0) {
      yield {
        kind: 'run-end',
        reason: 'all-resolved',
        finalLedger: ledger,
      }
      return
    }
    // (b) tool-budget cap
    if (ledger.toolBudgetRemaining <= 0) {
      yield {
        kind: 'run-end',
        reason: 'budget-cap-hit',
        finalLedger: ledger,
        detail: 'tool budget exhausted',
      }
      return
    }
    // (c) wall-clock budget cap
    if (isWallClockBlown()) {
      yield {
        kind: 'run-end',
        reason: 'budget-cap-hit',
        finalLedger: ledger,
        detail: 'wall-clock budget exceeded',
      }
      return
    }
    // (d) user abort
    if (isAborted()) {
      yield {
        kind: 'run-end',
        reason: 'user-abort',
        finalLedger: ledger,
        detail: 'signal aborted after round end',
      }
      return
    }
  }

  // Loop fell through — hit `maxRounds` cap.
  yield {
    kind: 'run-end',
    reason: 'budget-cap-hit',
    finalLedger: ledger,
    detail: `maxRounds=${budget.maxRounds} reached`,
  }
}

/* -------------------------------------------------------------------------- */
/* runPev — public wrapper with optional dashboard mirror                     */
/* -------------------------------------------------------------------------- */

/**
 * Drive the PEV loop end-to-end and yield events as they happen.
 *
 * This is the public entry point. It wraps {@link runPevCore} with an
 * optional dashboard mirror: when `opts.enableDashboard === true`, every
 * yielded event is also pushed to a localhost HTTP server that streams
 * to connected browser tabs via SSE. The wrapper is transparent — it
 * yields the exact same events as the core in the exact same order.
 *
 * Dashboard failures (port busy, push errors) are caught and logged at
 * debug level. They NEVER affect the PEV loop or its event stream.
 */
export async function* runPev(
  opts: PevRunOpts,
): AsyncGenerator<PevRoundEvent, void, void> {
  // Fast path: no dashboard requested → forward 1:1, zero overhead.
  if (!opts.enableDashboard) {
    yield* runPevCore(opts)
    return
  }

  // Slow path: lazy-import the dashboard machinery, start the server,
  // then iterate the core generator while mirroring each event.
  type DashboardHandle = {
    readonly url: string
    readonly port: number
    push(event: import('./dashboard/events.js').DashboardEvent): void
    close(): Promise<void>
  }
  let dashboard: DashboardHandle | null = null
  let toDashboardEventsFn:
    | typeof import('./dashboard/events.js').toDashboardEvents
    | null = null

  try {
    const dashMod = await import('./dashboard/server.js')
    const evMod = await import('./dashboard/events.js')
    const handle = await dashMod.startDashboard()
    if (handle) {
      dashboard = handle
      toDashboardEventsFn = evMod.toDashboardEvents
      // Print clickable URL to stderr — VS Code / iTerm2 / Windows
      // Terminal recognise OSC 8 hyperlinks. Falls back to plain text
      // when NO_COLOR is set.
      const url = handle.url
      const text = `📊 PEV Dashboard: ${url}`
      const formatted = process.env.NO_COLOR
        ? text
        : `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`
      process.stderr.write(formatted + '\n')
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.debug(`[pev/runner] dashboard startup failed: ${msg}`)
  }

  // Track ledger state alongside the event stream so we can serialise
  // the latest snapshot for the dashboard. Most PevRoundEvents either
  // carry a ledger directly or imply "use the most recently seen one".
  let lastLedger: SharedLedger = createEmptyLedger(opts.budget.maxToolCalls)
  let lastRound = 0
  const agentCount = opts.providers.length

  /** Best-effort push — never throws. */
  function safePush(event: PevRoundEvent): void {
    if (!dashboard || !toDashboardEventsFn) return
    try {
      // Update local ledger tracking for serialisation.
      if (event.kind === 'ledger-update' || event.kind === 'round-end') {
        lastLedger = event.ledger
        if (event.kind === 'round-end') lastRound = event.round
      } else if (event.kind === 'run-end') {
        lastLedger = event.finalLedger
      } else if (event.kind === 'round-start') {
        lastRound = event.round
      }
      const dashEvents = toDashboardEventsFn(event, lastLedger, agentCount, lastRound)
      for (const de of dashEvents) {
        dashboard.push(de)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.debug(`[pev/runner] dashboard push failed: ${msg}`)
    }
  }

  try {
    for await (const event of runPevCore(opts)) {
      safePush(event)
      yield event
    }
  } finally {
    // Always close the dashboard, even if the consumer breaks out of
    // the for-await loop early (e.g. they only wanted N events).
    if (dashboard) {
      try {
        await dashboard.close()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.debug(`[pev/runner] dashboard close failed: ${msg}`)
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Re-exports — documented surface for downstream callers                     */
/* -------------------------------------------------------------------------- */

// We deliberately re-export commonly-co-imported types so consumers
// (T11 persistence, T12 command, T13 UI) can `import { ... } from
// '../../services/cav/pev/pevRunner.js'` without hopping through every
// leaf module.
export type { PevBudget, AgentDescriptor } from './scheduler.js'
export type { ParseResult } from './parser.js'
export type {
  Hypothesis,
  ToolEvidence,
  SharedLedger,
  HypothesisStatus,
  ToolOutcome,
  ParseStats,
} from './ledger.js'
export type {
  PevOutput,
  Verdict,
  HypothesisUpdate,
  HypothesisKind,
} from './protocol.js'
export type { ToolPlan, ToolName } from './canonicalTests.js'
export type { ParseErrorKind } from './validator.js'

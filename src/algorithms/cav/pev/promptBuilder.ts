/**
 * Prompt Builder — assemble the system + user prompts handed to each
 * agent at the start of every PEV round.
 *
 * The PEV protocol is the contract that lets a deterministic state
 * machine (`ledger.ts`) consume LLM free-form output. For that contract
 * to bind, every agent MUST be told — every round — exactly:
 *   1. the three-section output shape (prose / pev block / cav block),
 *   2. the strict zod schema constraints in human-readable form,
 *   3. the closed canonical tool-plan whitelist (so the model cannot
 *      fabricate tool calls),
 *   4. its current world (active hypotheses, inbox, scheduler directive).
 *
 * This module owns 1-3 (system prompt — same shape for the whole run)
 * and 4 (user prompt — refreshed each round).
 *
 * Hard rules (audited):
 *   - **Pure function**. No I/O, no `Date.now()`, no global state.
 *   - **Token budget** (R1-11): the design caps each prompt at ~4000
 *     tokens; we use the conservative coarse heuristic of 4 chars/token
 *     and floor at {@link MAX_PROMPT_CHARS}. When real data overflows,
 *     we truncate gracefully — most-recent items survive. We never
 *     produce a prompt that is missing the protocol constraints, even
 *     under extreme overflow.
 *   - **Single source of truth** for tool-plan listing. The system
 *     prompt enumerates `CANONICAL_TESTS` directly; downstream changes
 *     to that table flow through automatically.
 *   - **Identity reinforcement** (R1-5). The system prompt names the
 *     agent's id verbatim, then names it again as a constraint in the
 *     example. That redundancy buys robustness against drift.
 *
 * Cross-references:
 *   - .kiro/specs/ccb-pev-re-execution-loop/design.md → Component 1,
 *     Component 9 / agent prompt section
 *   - .kiro/specs/ccb-pev-re-execution-loop/requirements.md → R1-1 ..
 *     R1-11
 */

import {
  CANONICAL_TESTS,
  type ToolPlan,
} from './canonicalTests.js'
import type { Hypothesis, SharedLedger, ToolEvidence } from './ledger.js'
import {
  PEV_SCHEMA_VERSION,
  type HypothesisKind,
} from './protocol.js'
import type { AgentInbox } from './propagator.js'
import type { ScheduleDirective } from './scheduler.js'

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Coarse upper bound on the size of any built prompt, in characters. The
 * design budget is 4000 tokens; with the standard ~4 chars/token
 * heuristic that maps to 16 000 chars. Hitting this ceiling triggers
 * graceful truncation of dynamic sections (active hypotheses, inbox);
 * the protocol description itself is never trimmed.
 */
export const MAX_PROMPT_CHARS = 16_000

/**
 * Hard cap on resultDigest fragments embedded in the user prompt. Each
 * evidence carries a digest already capped to ≤ 500 chars by the
 * runner; we additionally trim to this length per inline mention so
 * even 5 evidence entries never bust the inbox section's char budget.
 */
const EVIDENCE_DIGEST_INLINE_LIMIT = 240

/* -------------------------------------------------------------------------- */
/* Public option types                                                        */
/* -------------------------------------------------------------------------- */

/** Inputs to {@link buildAgentSystemPrompt}. */
export type SystemPromptOpts = {
  /** The agent's persistent id (becomes the `agent_id` constraint). */
  readonly agentId: string
  /** Optional preferred kind — only used to tag the agent role line. */
  readonly kind?: HypothesisKind
  /**
   * The user's natural-language goal that kicked off this PEV run, e.g.
   * "判断加壳 + 主体语言 + 反调试". Embedded verbatim so the agent has
   * the original intent on every system-prompt rebuild.
   */
  readonly initialClaim: string
}

/** Inputs to {@link buildAgentUserPrompt}. */
export type UserPromptOpts = {
  readonly agentId: string
  readonly round: number
  /** Optional scheduler directive; absent when scheduler had no candidate. */
  readonly directive?: ScheduleDirective
  /** Optional propagator inbox; absent when nothing to propagate. */
  readonly inbox?: AgentInbox
  /** Current ledger snapshot — read-only. */
  readonly ledger: SharedLedger
}

/* -------------------------------------------------------------------------- */
/* System prompt                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build the system prompt: a stable header that explains the PEV
 * protocol and enumerates every legal tool plan. Output is a single
 * Markdown string ≤ {@link MAX_PROMPT_CHARS}.
 */
export function buildAgentSystemPrompt(opts: SystemPromptOpts): string {
  const { agentId, kind, initialClaim } = opts
  const roleLine = kind != null
    ? `agent_id: \`${agentId}\` · specialty: \`${kind}\``
    : `agent_id: \`${agentId}\``

  const sections: string[] = [
    `# PEV Protocol Brief`,
    `${roleLine}`,
    '',
    `You are a Reverse-Engineering analyst inside a Plan-Execute-Verify loop. ` +
      `Each round you observe the shared ledger, propose hypothesis updates, ` +
      `and choose ONE next action. The loop is driven by a deterministic ` +
      `state machine — not by your memory — so your output MUST conform to ` +
      `the schema below or it will be discarded.`,
    '',
    `## Initial claim (user goal)`,
    '',
    `> ${truncateOneLine(initialClaim, 600)}`,
    '',
    buildOutputContractSection(agentId),
    '',
    buildSchemaConstraintsSection(agentId),
    '',
    buildPositiveExampleSection(agentId),
    '',
    buildForbiddenSection(),
    '',
    buildToolPlanWhitelistSection(),
  ]

  const out = sections.join('\n')
  // The system prompt is dominated by static content; we expect it to
  // fit comfortably under MAX_PROMPT_CHARS. Defensive cap anyway, with
  // a clear marker if we ever blow through (e.g. canonical table grows).
  return clampWithMarker(out, MAX_PROMPT_CHARS)
}

/**
 * The "three sections in fixed order" contract — section 2 of R1-1.
 */
function buildOutputContractSection(agentId: string): string {
  return [
    `## Output format — three sections, IN ORDER`,
    '',
    `1. \`## 1. 内容\` — free-text reasoning (≤ 600 chars)`,
    '2. ` ```pev ` fenced JSON block — exactly ONE object, schema below',
    '3. ` ```cav ` fenced JSON block — existing CAV protocol (do not invent here)',
    '',
    `These three sections MUST appear once each, in that order. Reordering ` +
      `or omitting any of them is a protocol violation; your output for the ` +
      `round is then discarded.`,
    '',
    `Your \`agent_id\` field must be exactly \`"${agentId}"\`. The runner ` +
      `cross-checks this — mismatched ids are rejected.`,
  ].join('\n')
}

/**
 * Field-level constraints — section 2 of R1.
 */
function buildSchemaConstraintsSection(agentId: string): string {
  return [
    `## PEV JSON schema (snake_case, strict)`,
    '',
    `Top-level (ALL required):`,
    `- \`schema_version\` — literal string \`"${PEV_SCHEMA_VERSION}"\`. ` +
      `NOT \`1.0\` (number), NOT \`"1.0.0"\`, NOT \`"v1.0"\`.`,
    `- \`agent_id\` — string, MUST equal \`"${agentId}"\`.`,
    `- \`round\` — integer ≥ 0, MUST equal the current round number ` +
      `provided in the user prompt.`,
    `- \`observations\` — array, length 0..8.`,
    `- \`hypothesis_updates\` — array, length 0..8.`,
    `- \`next_action\` — object (discriminated union, see below).`,
    '',
    `### \`observations[i]\``,
    '',
    `\`\`\`json`,
    `{ "evidence_id": "E<n>", "verdict": "confirms" | "falsifies" | "mutates" | "inconclusive", "confidence": 0..1 }`,
    `\`\`\``,
    '',
    `\`evidence_id\` must already exist in the ledger; you cite ids, ` +
      `you do NOT mint them.`,
    '',
    `### \`hypothesis_updates[i]\` — 5 op types, discriminator \`op\``,
    '',
    `- **create**: \`{ "op":"create", "id", "parent_id"?, "kind", "text", "confidence" }\``,
    `- **promote**: \`{ "op":"promote", "id", "rationale_short" }\``,
    `- **falsify**: \`{ "op":"falsify", "id", "counter_evidence_id", "rationale_short" }\``,
    `- **mutate**: \`{ "op":"mutate", "id", "new_id", "text", "confidence", "rationale_short" }\``,
    `- **confidence_adjust**: \`{ "op":"confidence_adjust", "id", "new_confidence", "rationale_short" }\``,
    '',
    `\`HypothesisId\` regex: \`^H\\d+(\\.\\d+){0,3}$\` — max depth 4 ` +
      `(\`H1\`, \`H1.2\`, \`H1.2.3\`, \`H1.2.3.4\`).`,
    `\`HypothesisKind\`: \`file-class\` | \`packer\` | \`compiler\` | \`family\` | ` +
      `\`algorithm\` | \`anti-analysis\` | \`capability\` | \`protocol\`.`,
    '',
    `### \`next_action\` — 4 kinds, discriminator \`kind\``,
    '',
    `- **tool_call**: \`{ "kind":"tool_call", "hypothesis_id", "tool_plan_id", "args_override" }\``,
    `- **observe_only**: \`{ "kind":"observe_only", "rationale" }\``,
    `- **request_oracle**: \`{ "kind":"request_oracle", "query", "rationale" }\``,
    `- **declare_done**: \`{ "kind":"declare_done", "rationale" }\``,
    '',
    `\`tool_plan_id\` MUST come from the whitelist below. \`args_override\` ` +
      `is either \`null\` (use plan defaults) or an object whose keys are a ` +
      `subset of that plan's \`overridable_fields\`.`,
  ].join('\n')
}

/**
 * A single, schema-valid example. Hand-crafted to match every constraint
 * called out in {@link buildSchemaConstraintsSection}.
 */
function buildPositiveExampleSection(agentId: string): string {
  return [
    `## ✅ Complete positive example`,
    '',
    '```pev',
    `{`,
    `  "schema_version": "${PEV_SCHEMA_VERSION}",`,
    `  "agent_id": "${agentId}",`,
    `  "round": 0,`,
    `  "observations": [],`,
    `  "hypothesis_updates": [`,
    `    {`,
    `      "op": "create",`,
    `      "id": "H1",`,
    `      "kind": "packer",`,
    `      "text": "PE32+ payload may be packed by UPX 4.x",`,
    `      "confidence": 0.6`,
    `    }`,
    `  ],`,
    `  "next_action": {`,
    `    "kind": "tool_call",`,
    `    "hypothesis_id": "H1",`,
    `    "tool_plan_id": "packer::diec",`,
    `    "args_override": null`,
    `  }`,
    `}`,
    '```',
  ].join('\n')
}

/**
 * Failure-mode catalogue. Calls out the high-frequency mistakes the
 * three-layer parser sees in real LLM output.
 */
function buildForbiddenSection(): string {
  return [
    `## ❌ Forbidden`,
    '',
    `- No \`// ...\` or \`/* ... */\` comments inside the JSON block.`,
    `- No trailing commas.`,
    `- No camelCase keys — use snake_case (\`evidence_id\`, NOT \`evidenceId\`; ` +
      `\`hypothesis_updates\`, NOT \`hypothesisUpdates\`).`,
    `- \`schema_version\` is the literal string \`"${PEV_SCHEMA_VERSION}"\` — ` +
      `never the numeric \`${PEV_SCHEMA_VERSION}\`, never \`"v${PEV_SCHEMA_VERSION}"\`.`,
    `- The discriminator field is \`op\` (hypothesis_updates) or \`kind\` ` +
      `(next_action). NEVER \`type\`, NEVER \`action\`.`,
    `- \`args_override\` keys MUST be a subset of the chosen plan's ` +
      `\`overridable_fields\`. Adding new keys is rejected.`,
    `- HypothesisId depth is capped at 4 (\`H1.2.3.4\` is the deepest legal id).`,
    `- Same-array \`hypothesis_updates\` MUST NOT contain both \`promote\` ` +
      `and \`falsify\` for the same id.`,
  ].join('\n')
}

/**
 * Tool plan whitelist, grouped by kind. The model picks `tool_plan_id`
 * from this list and nothing else; runner-side validation rejects any
 * id not enumerated here.
 */
function buildToolPlanWhitelistSection(): string {
  const lines: string[] = [
    `## Tool plan whitelist`,
    '',
    `You may set \`next_action.tool_plan_id\` ONLY to one of the ids below. ` +
      `Anything else fails validation. Plans are grouped by hypothesis kind.`,
    '',
  ]

  // Stable kind order matches the protocol enum.
  const kindOrder: readonly HypothesisKind[] = [
    'file-class',
    'packer',
    'compiler',
    'family',
    'algorithm',
    'anti-analysis',
    'capability',
    'protocol',
  ]

  // Pre-bucket plans by kind in a single pass over CANONICAL_TESTS so
  // the section build is O(N) and respects declaration order within
  // each bucket.
  const byKind = new Map<HypothesisKind, ToolPlan[]>()
  for (const k of kindOrder) byKind.set(k, [])
  for (const plan of Object.values(CANONICAL_TESTS)) {
    byKind.get(plan.kind)?.push(plan)
  }

  for (const k of kindOrder) {
    const plans = byKind.get(k) ?? []
    if (plans.length === 0) continue
    lines.push(`### ${k}`)
    lines.push('')
    for (const p of plans) {
      const overridable =
        p.overridable_fields.length === 0
          ? '(none)'
          : p.overridable_fields.join(', ')
      lines.push(
        `- \`${p.id}\` — ${truncateOneLine(p.description, 160)} ` +
          `(tool: \`${p.tool}\`, overridable: ${overridable})`,
      )
    }
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/* -------------------------------------------------------------------------- */
/* User prompt                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Build the per-round user prompt: this agent's view of the world plus
 * the scheduler directive (if any). Output is a single Markdown string
 * ≤ {@link MAX_PROMPT_CHARS}; sections are truncated tail-first when the
 * full text would overflow.
 *
 * Section order:
 *   1. Header — round + agent_id (always present, never trimmed)
 *   2. Active hypotheses — this agent only, status ∈ {open, evidence}
 *   3. Inbox — present only when {@link UserPromptOpts.inbox} carries
 *      content (no empty-section header)
 *   4. Directive — present only when the scheduler suggested anything
 *   5. Footer — output-format reminder (always present, never trimmed)
 */
export function buildAgentUserPrompt(opts: UserPromptOpts): string {
  const { agentId, round, directive, inbox, ledger } = opts

  // Header is always emitted verbatim; the runner relies on its
  // presence for parser-side identity/round cross-validation prompts.
  const header = `## Round ${round} · agent_id: \`${agentId}\``

  // Footer reminds the agent of the output-shape contract from system
  // prompt. Cheap insurance against drift over many rounds.
  const footer = [
    `---`,
    `Output the three sections in order: prose / \`\`\`pev block / \`\`\`cav block.`,
    `Reminder: \`agent_id\` must equal \`"${agentId}"\` and \`round\` must equal \`${round}\`.`,
  ].join('\n')

  const activeSection = renderActiveHypothesesSection(ledger, agentId)
  const inboxSection = renderInboxSection(inbox)
  const directiveSection = renderDirectiveSection(directive)

  // Assemble in canonical order; skip empty sections so we never emit
  // bare headers (R: "When inbox is empty → no inbox section header").
  const dynamic: string[] = []
  if (activeSection !== null) dynamic.push(activeSection)
  if (inboxSection !== null) dynamic.push(inboxSection)
  if (directiveSection !== null) dynamic.push(directiveSection)

  const fullDynamic = dynamic.join('\n\n')
  const headerFooterSize = header.length + footer.length + 4 /* joiners */
  const dynamicBudget = Math.max(0, MAX_PROMPT_CHARS - headerFooterSize)

  // Truncate the dynamic block tail-first when needed. We keep the
  // active-hypothesis listing intact whenever possible (it's most
  // load-bearing for the agent's reasoning) and trim from the tail
  // (directive ↘ inbox ↘ active) only on overflow.
  const trimmedDynamic =
    fullDynamic.length <= dynamicBudget
      ? fullDynamic
      : truncateDynamicTail(dynamic, dynamicBudget)

  return [header, '', trimmedDynamic, '', footer].join('\n')
}

/**
 * Render this agent's active-hypothesis list. Returns `null` when the
 * agent has no active hypotheses — caller suppresses the section.
 */
function renderActiveHypothesesSection(
  ledger: SharedLedger,
  agentId: string,
): string | null {
  const own: Hypothesis[] = []
  for (const h of ledger.hypotheses.values()) {
    if (h.ownerAgent !== agentId) continue
    if (h.status !== 'open' && h.status !== 'evidence') continue
    own.push(h)
  }
  if (own.length === 0) {
    // Even with zero active H, we still emit a brief notice so the
    // agent knows the section was considered — observe_only is the
    // expected next_action in this case.
    return [
      `### Your active hypotheses`,
      '',
      `_(none — consider \`observe_only\` or \`declare_done\`)_`,
    ].join('\n')
  }

  // Sort by id (lexicographic) for stable output across runs.
  own.sort((a, b) => a.id.localeCompare(b.id))

  const lines: string[] = [`### Your active hypotheses`, '']
  for (const h of own) {
    lines.push(
      `- \`${h.id}\` [${h.status}] (${h.kind}) ` +
        `conf=${h.confidence.toFixed(2)} — ${truncateOneLine(h.text, 160)}`,
    )
  }
  return lines.join('\n')
}

/**
 * Render the propagator inbox. Returns `null` when there is no inbox or
 * the inbox is fully empty — caller suppresses the section header per
 * R: "When inbox is empty → no inbox section header".
 */
function renderInboxSection(inbox: AgentInbox | undefined): string | null {
  if (!inbox) return null
  const hasEvidence = inbox.newEvidenceForMe.length > 0
  const hasHints = inbox.newHypothesisFromPeer.length > 0
  const hasStale = inbox.staleNotice.length > 0
  const hasSchedHint =
    typeof inbox.hintFromScheduler === 'string' &&
    inbox.hintFromScheduler.length > 0
  if (!hasEvidence && !hasHints && !hasStale && !hasSchedHint) return null

  const lines: string[] = [`### Inbox`, '']

  if (hasEvidence) {
    lines.push(`**New evidence for you (most relevant first):**`)
    for (const ev of inbox.newEvidenceForMe) {
      lines.push(formatEvidenceLine(ev))
    }
    lines.push('')
  }

  if (hasHints) {
    lines.push(`**Sub-hypothesis hints from peers:**`)
    for (const h of inbox.newHypothesisFromPeer) {
      const parent = h.parentId ? ` parent=\`${h.parentId}\`` : ''
      lines.push(
        `- \`${h.id}\` (${h.kind})${parent} — ${truncateOneLine(h.text, 160)}`,
      )
    }
    lines.push('')
  }

  if (hasStale) {
    lines.push(`**Stale notices (drop these branches):**`)
    lines.push(`- ${inbox.staleNotice.map(s => `\`${s}\``).join(', ')}`)
    lines.push('')
  }

  if (hasSchedHint) {
    lines.push(`**Scheduler hint:** ${inbox.hintFromScheduler}`)
    lines.push('')
  }

  // Strip trailing blank line we may have accumulated.
  return lines.join('\n').trimEnd()
}

/** One-liner format for an evidence inbox entry. */
function formatEvidenceLine(ev: ToolEvidence): string {
  const digest = truncateOneLine(ev.resultDigest, EVIDENCE_DIGEST_INLINE_LIMIT)
  // Causal-intervention rows surface their structured do-calculus
  // verdict + strength + manipulated variable in a parenthetical so
  // agents can read it without parsing the digest text.
  const causalSuffix =
    ev.isCausalIntervention && ev.causalVerdict !== undefined
      ? ` [causal=${ev.causalVerdict}, strength=${ev.causalStrength ?? 0}` +
        (ev.manipulatedVariable
          ? `, manipulated="${ev.manipulatedVariable}"`
          : '') +
        `]`
      : ''
  return (
    `- \`${ev.id}\` verdict=**${ev.verdict}**${causalSuffix} ` +
    `(round ${ev.round}, agent: \`${ev.agentId}\`, ` +
    `tool: \`${ev.toolName}\`, tested: \`${ev.testedHypothesis}\`) — ${digest}`
  )
}

/**
 * Render the scheduler directive when present. Returns `null` for an
 * absent directive; an empty directive (no fields set) still emits a
 * brief "no specific suggestion" line so the agent knows the channel
 * was considered.
 */
function renderDirectiveSection(
  directive: ScheduleDirective | undefined,
): string | null {
  if (!directive) return null
  const hasAny =
    directive.suggestedHypothesisId !== undefined ||
    directive.suggestedToolPlanId !== undefined ||
    (typeof directive.hint === 'string' && directive.hint.length > 0)
  if (!hasAny) return null

  const lines: string[] = [`### Scheduler directive`, '']
  if (directive.suggestedHypothesisId !== undefined) {
    lines.push(
      `- suggested hypothesis: \`${directive.suggestedHypothesisId}\``,
    )
  }
  if (directive.suggestedToolPlanId !== undefined) {
    lines.push(
      `- suggested tool plan: \`${directive.suggestedToolPlanId}\``,
    )
  }
  if (typeof directive.hint === 'string' && directive.hint.length > 0) {
    lines.push(`- hint: ${directive.hint}`)
  }
  return lines.join('\n')
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Single-line truncation: replace any embedded newlines with spaces and
 * cap at `max` chars (appending `…` when truncated). Cheap and visually
 * stable in Markdown bullets.
 */
function truncateOneLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Hard cap at `max` chars, appending a clearly-visible truncation
 * marker. Used as a defensive ceiling for the system prompt; we don't
 * expect to hit it in practice.
 */
function clampWithMarker(s: string, max: number): string {
  if (s.length <= max) return s
  const marker = '\n\n…[prompt truncated to fit budget]'
  const headLen = Math.max(0, max - marker.length)
  return `${s.slice(0, headLen)}${marker}`
}

/**
 * Tail-first truncation across the dynamic sections of the user prompt.
 *
 * Strategy:
 *   1. Keep sections from the head until adding the next would exceed
 *      `budget` (with section joiners).
 *   2. If even the FIRST section exceeds the budget, hard-clamp it.
 *   3. Append a one-line marker so the agent knows we truncated.
 *
 * Sections were pushed into `ordered` in priority order (active
 * hypotheses, inbox, directive). Trimming from the tail preserves the
 * most decision-critical info first.
 */
function truncateDynamicTail(
  ordered: readonly string[],
  budget: number,
): string {
  const marker = '\n\n…[user prompt truncated to fit budget]'
  const effectiveBudget = Math.max(0, budget - marker.length)
  const kept: string[] = []
  let used = 0
  for (let i = 0; i < ordered.length; i += 1) {
    const sec = ordered[i]!
    // Joiner of "\n\n" between sections, except before the first one.
    const joiner = kept.length === 0 ? 0 : 2
    const next = used + joiner + sec.length
    if (next <= effectiveBudget) {
      kept.push(sec)
      used = next
      continue
    }
    // Doesn't fit. If we already kept anything, stop here. Otherwise
    // hard-clamp this single section so we never return an empty body.
    if (kept.length === 0) {
      kept.push(sec.slice(0, effectiveBudget))
      used = effectiveBudget
    }
    break
  }
  return `${kept.join('\n\n')}${marker}`
}

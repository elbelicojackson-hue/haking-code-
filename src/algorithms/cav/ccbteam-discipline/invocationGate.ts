/**
 * T16 — Invocation Gate (R12).
 *
 * Pure prompt-content discipline. Appends a 5-precondition + ≥6 anti-
 * pattern summary to the existing `HELP_REPLY` so orchestrator agents
 * see the gate without us having to hand-edit the help text.
 *
 * Hard rules (audited):
 *   - Pure: same input string → same output string.
 *   - Output increment ≤ 800 characters (R12-4).
 *   - Output contains every `gate-*` id verbatim (R11-9).
 *   - Output contains zero Math Layer keywords (R12-6 / R5-9 scanner
 *     covers this).
 *
 * Cross-references:
 *   - .kiro/specs/super-agent-cluster/requirements.md → R12
 *   - .kiro/specs/super-agent-cluster/design.md → "Component 6"
 */

import {
  INVOCATION_ANTI_PATTERNS,
  INVOCATION_GATE_PRECONDITIONS,
} from '../ccbteam-math/constants.js'

/** Maximum allowed length increase over `helpText` (R12-4). */
export const MAX_GATE_APPENDIX_BYTES = 800

/**
 * Append the Invocation Gate summary to a HELP_REPLY string.
 *
 * @param helpText — original ccbteam HELP_REPLY (left intact).
 * @returns helpText plus appended `## Invocation Gate` + `## 反模式` sections.
 */
export function applyInvocationGate(helpText: string): string {
  const gateSection = renderInvocationGateSection()
  const antiSection = renderAntiPatternsSection()
  const appendix = `\n\n${gateSection}\n\n${antiSection}\n`
  // Guard: although we count characters in our default rendering, defend
  // against accidental future bloat by truncating (with a marker) when
  // the appendix exceeds the budget.
  const finalAppendix =
    appendix.length <= MAX_GATE_APPENDIX_BYTES
      ? appendix
      : appendix.slice(0, MAX_GATE_APPENDIX_BYTES - 4) + '...\n'
  return `${helpText}${finalAppendix}`
}

/**
 * Render the `## Invocation Gate` section as a deterministic 5-line
 * bullet list with `[gate-*]` ids.
 */
export function renderInvocationGateSection(): string {
  const lines: string[] = ['## Invocation Gate(何时该用 ccbteam)', '']
  for (const p of INVOCATION_GATE_PRECONDITIONS) {
    lines.push(`- [${p.id}] ${p.title}: ${p.summary}`)
  }
  return lines.join('\n')
}

/**
 * Render the `## 反模式` section listing the ≥6 anti-patterns.
 */
export function renderAntiPatternsSection(): string {
  const lines: string[] = ['## 反模式(何时不该用)', '']
  for (const a of INVOCATION_ANTI_PATTERNS) {
    lines.push(`- ${a}`)
  }
  return lines.join('\n')
}

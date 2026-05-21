/**
 * T17 — Epistemic Honesty Block builder (R13).
 *
 * Renders the `<epistemic>` self-report protocol + 5 [E#] hard rules
 * as a single Markdown string ready to inject into V2 `buildPrompt.ts`.
 *
 * Hard rules (audited):
 *   - Pure: zero arguments, deterministic output (constant function).
 *   - Output contains every `[E#]` rule literally (T17 test).
 *   - Output contains zero Math Layer keywords (R13 / R5-9 scanner).
 *
 * Cross-references:
 *   - .kiro/specs/super-agent-cluster/requirements.md → R13
 *   - .kiro/specs/super-agent-cluster/design.md → "Component 6 / Pinned
 *     Constant 8"
 */

import {
  EPISTEMIC_HONESTY_RULES,
  KNOWLEDGE_ZONES,
} from '../ccbteam-math/constants.js'

/**
 * Build the Epistemic Honesty Block. Returns a single multi-line
 * Markdown string with the JSON template + 5 [E#] hard rules + a
 * Zahavian-style closing paragraph.
 */
export function buildEpistemicHonestyBlock(): string {
  const zones = KNOWLEDGE_ZONES.join('|')
  const lines: string[] = []
  lines.push('## 认知边界纪律 (R13)')
  lines.push('')
  lines.push(
    '每次发言**除了** `<cav>` 块,还必须紧跟一个独立的 `<epistemic>` 自报块,5 字段 JSON:',
  )
  lines.push('')
  lines.push('```epistemic')
  lines.push('{')
  lines.push(`  "knowledge_zone": "<${zones}>",`)
  lines.push('  "training_cutoff_aware": "<YYYY-MM|unknown>",')
  lines.push('  "oracle_used": null | "<oracle reference>",')
  lines.push(
    '  "claim_grounded_in": "<source label, e.g. memory|oracle:firecrawl-3|profile:reverse>",',
  )
  lines.push('  "refusal_when_unknown": <true|false>')
  lines.push('}')
  lines.push('```')
  lines.push('')
  lines.push('### 5 条硬规则')
  lines.push('')
  for (const r of EPISTEMIC_HONESTY_RULES) {
    lines.push(`[${r.id}] ${r.rule}`)
    lines.push('')
  }
  lines.push(
    '伪造 epistemic 字段的代价 ≥ 收益(Zahavian §6.7 类比):评审会用 5 条规则的合规率给你打"epistemic_violations 计数",违反多的 agent 在事后回执的"知识边界违反统计"中被点名。',
  )
  return lines.join('\n')
}

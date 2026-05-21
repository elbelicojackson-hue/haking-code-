/**
 * Pinned Constants — CR-EIG / Pure Observer / Discipline Layer.
 *
 * Every constant in this file is a frozen value with a corresponding
 * Acceptance Criterion in `.kiro/specs/super-agent-cluster/requirements.md`
 * and a derivation note in design.md → "Pinned Constants".
 *
 * Modifying any value here SHOULD be paired with bumping the requirement
 * + design + a follow-up PBT update. Runtime callers must NOT mutate.
 */

import type { ToolPlan } from '../pev/canonicalTests.js'
import type { CrEigWeights, GradientId, RepairStyle } from './types.js'

/* -------------------------------------------------------------------------- */
/* Constant 1 — cost_in_bits 表 (R6-2)                                         */
/* -------------------------------------------------------------------------- */

/**
 * Map a {@link ToolPlan.cost_estimate} bucket to the bit-units cost
 * penalty used by `crEig.ts`.
 *
 * Geometric ×3 ladder; `large` bound = `binaryEntropy(0.5)` = 1 bit so
 * that the cost penalty term is dimensionally compatible with the EIG
 * main term (see design.md → Pinned Constant 1).
 */
export const COST_IN_BITS_TABLE = {
  tiny: 0.05,
  small: 0.15,
  medium: 0.4,
  large: 1.0,
} as const satisfies Record<ToolPlan['cost_estimate'], number>

export type CostEstimate = keyof typeof COST_IN_BITS_TABLE

/* -------------------------------------------------------------------------- */
/* Constant 2 — utility u_i 三项权重 (R3-6)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Strict convex combination (Σ === 1.0) used by `utility.estimateUtility`
 * when oracle anchors are available.
 *
 * `groupAlignment` slightly exceeds the others because it is the only
 * channel that *directly* measures the multi-agent meta-communication
 * dimension (CAV's core innovation).
 */
export const UTILITY_WEIGHTS = {
  beliefConsistency: 0.3,
  groupAlignment: 0.4,
  oracleMatch: 0.3,
} as const

/**
 * Re-normalised weights for the no-oracle fallback path. Derived from
 * UTILITY_WEIGHTS by redistributing the 0.3 oracle slice proportionally
 * to belief and group (preserves their relative weight ratio 3:4).
 *
 *   W_BELIEF_NO_ORACLE = 0.30 / 0.70 ≈ 0.4286
 *   W_GROUP_NO_ORACLE  = 0.40 / 0.70 ≈ 0.5714
 */
export const W_BELIEF_NO_ORACLE = UTILITY_WEIGHTS.beliefConsistency / (
  UTILITY_WEIGHTS.beliefConsistency + UTILITY_WEIGHTS.groupAlignment
)
export const W_GROUP_NO_ORACLE = UTILITY_WEIGHTS.groupAlignment / (
  UTILITY_WEIGHTS.beliefConsistency + UTILITY_WEIGHTS.groupAlignment
)

/**
 * Strategy-conditioned utility nudge. Breaks the 5-way symmetry that
 * would otherwise drive `exploitability.eps` to ≈ 0 for every record
 * set — see R7-4 / design.md "Pinned Constant 2 — utility 计算公式".
 *
 * Magnitude bound: every entry's |x| ≤ STRATEGY_ADJUSTMENT_MAX_DELTA.
 */
export const STRATEGY_ADJUSTMENT_TABLE = {
  defend: 0.02,
  concede: 0.03,
  substitute: -0.02,
  split: 0,
  none: 0,
} as const satisfies Record<RepairStyle, number>

/**
 * Upper bound on |entry| in {@link STRATEGY_ADJUSTMENT_TABLE}. Used by
 * R7-4 PBT to assert ε_t ≤ this value when all strategies tie.
 */
export const STRATEGY_ADJUSTMENT_MAX_DELTA = 0.05

/* -------------------------------------------------------------------------- */
/* Constant 3 — EPS_MAX (R3-3)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Upper bound of `exploitability.eps`. Since `u_i ∈ [0, 1]` (convex
 * combination of [0, 1] inputs), `max gain = 1 − 0 = 1`. Setting EPS_MAX
 * to 1.0 makes `ρ_t = 1 − ε_t` algebraically tight (no scaling needed).
 */
export const EPS_MAX = 1.0

/* -------------------------------------------------------------------------- */
/* Constant 4 — DEFAULT_CR_EIG_WEIGHTS (R6-1)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Default CR-EIG weight bundle. Hand-calibrated so the upper bound is
 * `1 + γ_caus·0.5 + κ = 1.5 bits` and the lower bound is
 * `−λ_cost · cost_max = −0.05 bits` (R7-2).
 */
export const DEFAULT_CR_EIG_WEIGHTS: CrEigWeights = {
  lambdaCost: 0.05,
  gammaCausal: 0.3,
  kappaUrgency: 0.2,
  gammaExplore: 0.1,
  deltaZero: 0.2,
  useAdaptiveDelta: true,
}

/* -------------------------------------------------------------------------- */
/* Constant 5 — Sidecar 轮询参数                                               */
/* -------------------------------------------------------------------------- */

/** Polling cadence — matches React effect tick budget. */
export const SIDECAR_POLL_INTERVAL_MS = 120

/** Per-poll compute budget; exceedance counts as one miss. */
export const SIDECAR_POLL_BUDGET_MS = 30

/** Consecutive misses that trigger sidecar degradation. */
export const SIDECAR_DEGRADE_AFTER_MISSES = 3

/* -------------------------------------------------------------------------- */
/* Constant 6 — Invocation Gate 5 条 precondition (R12-2)                      */
/* -------------------------------------------------------------------------- */

/**
 * Single source of truth for the 5 Invocation-Gate preconditions. Order
 * matters: T19 steering file and T16 HELP_REPLY append rely on it for
 * deterministic rendering; PBT in R11-9 indexes by the `id` field.
 */
export const INVOCATION_GATE_PRECONDITIONS = [
  {
    id: 'gate-multi-perspective',
    title: 'Multi-Perspective Required',
    summary: 'claim 涉及伦理 / 估计 / 预测 / 主观判断,单一视角不足',
  },
  {
    id: 'gate-single-stalled',
    title: 'Single-Agent Stalled',
    summary: '主 agent 已对该 claim 给出 ≥ 2 次相互矛盾的判断或长期 hedge',
  },
  {
    id: 'gate-cross-validation',
    title: 'Cross-Validation Mandatory',
    summary: '用户显式要求 consensus / 共识 / cross-check / 4 链 / cav',
  },
  {
    id: 'gate-high-risk',
    title: 'High-Risk Decision',
    summary: 'claim 影响安全 / 合规 / 生产环境 / 不可逆操作',
  },
  {
    id: 'gate-knowledge-boundary',
    title: 'Knowledge Boundary Hit',
    summary: '主 agent 已识别该 claim 落在自身预训练知识边界外(R13)',
  },
] as const

export type InvocationGateId = typeof INVOCATION_GATE_PRECONDITIONS[number]['id']

/* -------------------------------------------------------------------------- */
/* Constant 7 — ccbteam Anti-Patterns (R12-3)                                  */
/* -------------------------------------------------------------------------- */

/** ≥ 6 anti-patterns, fixed order. */
export const INVOCATION_ANTI_PATTERNS = [
  '简单代码格式化 / 重命名 / lint 修复',
  '已知答案的事实查询(常量、API 签名、语法)',
  '用户已明确表态的偏好选择(如选 React 还是 Vue)',
  '单工具调用即可解决(grep / Read / 简单 Bash)',
  '上一轮已被某 oracle 直接证明的 claim',
  '同质化重复任务(如对 100 个文件做相同的 grep)',
] as const

/* -------------------------------------------------------------------------- */
/* Constant 8 — Epistemic Honesty 协议 (R13-3)                                 */
/* -------------------------------------------------------------------------- */

/**
 * The 5 hard rules `[E1]..[E5]` that every teammate must satisfy in the
 * `<epistemic>` self-report block. Renderers (T17) and the parser (T18)
 * both index by `id`.
 */
export const EPISTEMIC_HONESTY_RULES = [
  {
    id: 'E1',
    rule: '当 knowledge_zone === "outside" 且 oracle_used === null,必须 refusal_when_unknown === true,且 content 用一句不超过 80 字的"我不知道,需要 X 类 oracle 验证"取代具体主张。',
  },
  {
    id: 'E2',
    rule: '训练截止时间(model knowledge cutoff)已知则在 training_cutoff_aware 字段填 YYYY-MM 格式;若未知或不便公开则填 "unknown",禁止伪造日期。',
  },
  {
    id: 'E3',
    rule: '任何带具体数字 / 引文 / URL / 人名 / 公司名 / 论文标题的主张,必须在 claim_grounded_in 字段填入"具体来源标识"(如 oracle bundle id、profile.oracles 中的某一项、或 \'memory\' 标签);禁止留空。',
  },
  {
    id: 'E4',
    rule: 'oracle_used 与 claim_grounded_in 之间必须互不矛盾——oracle_used 非空时 claim_grounded_in 必须包含该 oracle 的某种 reference 标识。',
  },
  {
    id: 'E5',
    rule: '当其他 teammate 在前一轮指出"你的主张越界",本轮 repair_style 必须 ∈ {concede, split} 之一,不允许 defend / substitute,否则视为协议违反。',
  },
] as const

export type EpistemicRuleId = typeof EPISTEMIC_HONESTY_RULES[number]['id']

/** Knowledge-zone enumeration consumed by the `<epistemic>` parser. */
export const KNOWLEDGE_ZONES = ['core', 'edge', 'outside'] as const

export type KnowledgeZone = typeof KNOWLEDGE_ZONES[number]

/* -------------------------------------------------------------------------- */
/* Constant 9 — Strategy Space (gradient + repair_style)                       */
/* -------------------------------------------------------------------------- */

/**
 * The 5 ∇H gradient axes. Order is deterministic-tie-break order
 * (lex-asc on the literal `gradient` string per R4-3).
 */
export const GRADIENT_IDS = [
  'attack',
  'chain',
  'discretize',
  'oracle',
  'swap',
] as const satisfies readonly GradientId[]

/**
 * The 5 repair-style strategies considered by `exploitability`. Same
 * literal order as {@link STRATEGY_ADJUSTMENT_TABLE}'s declaration.
 */
export const STRATEGY_SPACE = [
  'defend',
  'concede',
  'substitute',
  'split',
  'none',
] as const satisfies readonly RepairStyle[]

/* -------------------------------------------------------------------------- */
/* Constant 10 — Numerical guards                                              */
/* -------------------------------------------------------------------------- */

/** Floor for `cavAdaptiveDelta` factors so δ_t > 0 strictly (R2-4). */
export const ADAPTIVE_DELTA_EPS_FLOOR = 1e-6

/** EIG / probability clamp bounds — mirrors `eigEngine.P_MIN/P_MAX`. */
export const PROB_CLAMP_MIN = 0.001
export const PROB_CLAMP_MAX = 0.999

/** Tie-break tolerance used by `rankGradients` (R4-3). */
export const RANK_TIE_TOLERANCE = 1e-6

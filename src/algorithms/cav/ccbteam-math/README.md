# 超级 Agent 集群 (Super Agent Cluster) — Math + Discipline Layers

> **Codename**: Super Agent Cluster
> **Spec**: `.kiro/specs/super-agent-cluster/{requirements,design,tasks}.md`
> **Public command**: `/ccbteam`(命令入口不变)

## What This Is

`ccbteam-math/` 与 `ccbteam-discipline/` 一起把 ccbteam 升级成"超级 Agent 集群":一个 4 链对抗共识团队 + 一个**纯观测**的旁路数学层 + 一个 prompt 内容纪律层。

> **核心设计哲学**:Math Layer 是一个**纯粹的上帝观测视角**(Pure God-Eye Observer)。它**只测量、不干预** — 不修改 prompt、不调度 dispatcher、不读旧文件。所有数学量(CR-EIG / ε_t / ρ_t)只用于事后回执 + 审计日志 + dashboard。
>
> Discipline Layer 是 prompt 内容纪律,**不**注入数学信号 — 它管"模型如何使用 ccbteam"(R12 Invocation Gate)与"模型如何踩在训练知识边界上"(R13 Epistemic Honesty)。

## Module Layout

```
src/services/cav/
├── ccbteam-math/            ← Pure Observer 数学层
│   ├── constants.ts          ← Pinned Constants (R3-3, R3-6, R6-1, R6-2)
│   ├── types.ts              ← Math Layer 公共类型
│   ├── cost.ts               ← costInBits
│   ├── delta.ts              ← cavAdaptiveDelta (R2)
│   ├── utility.ts            ← estimateUtility + bowCos
│   ├── exploitability.ts     ← ε_t (博弈论一阶定义)
│   ├── urgency.ts            ← ρ_t = 1 − ε_t
│   ├── crEig.ts              ← computeCrEig 主算子 (Algorithm 1)
│   ├── rankGradients.ts      ← 5 个 ∇H 排序
│   ├── auditLog.ts           ← append-only NDJSON
│   ├── sidecar.ts            ← Bootstrap + polling (R5-5 唯一入口)
│   └── __tests__/            ← PBT + 静态扫描守护
└── ccbteam-discipline/      ← Discipline Layer (R12 + R13)
    ├── invocationGate.ts     ← HELP_REPLY 增强 (R12-4)
    ├── epistemicBlock.ts     ← <epistemic> 协议段生成 (R13)
    ├── epistemicParser.ts    ← 5 条 [E#] 规则检查 (R13-4..R13-9)
    └── index.ts              ← 命令层导入入口

.kiro/steering/
└── ccbteam-invocation-discipline.md  ← R12-1 autoinclude
```

## Public API(供 sidecar / 命令层 / 测试使用)

```typescript
// Math Layer entry — sidecar bootstrap (R5-5)
import { startSidecar, type SidecarOptions } from './ccbteam-math/sidecar.js'

// Math Layer pure functions (sidecar internal use)
import { computeCrEig } from './ccbteam-math/crEig.js'
import { exploitability } from './ccbteam-math/exploitability.js'
import { consensusUrgency } from './ccbteam-math/urgency.js'
import { rankGradients } from './ccbteam-math/rankGradients.js'
import { cavAdaptiveDelta } from './ccbteam-math/delta.js'
import { costInBits } from './ccbteam-math/cost.js'

// Discipline Layer entry
import {
  applyInvocationGate,
  buildEpistemicHonestyBlock,
  parseAndCheckEpistemic,
} from './ccbteam-discipline/index.js'
```

## R5 Pure Observer Contract — 5 件事不能做

任何后续修改都必须严格遵守这条红线:

1. **不**写入 prompt — Math Layer 输出永远不进入 `buildCcbTeamPrompt` / `dispatcher.dispatchArena` / `Agent` 工具的 spawn 参数
2. **不**改 progressMessage — `--explain` 终端打印不进入模型上下文
3. **不**形成"测量 → 决策 → 测量"闭环 — audit log 是 append-only 且**永远不被运行时回读**
4. **不**做 token-level steering — 没有 logit bias、没有强制 JSON、没有抑制 token
5. **不**让命令层 import Math Layer 内部模块 — 唯一允许的入口是 `sidecar.ts`、`auditLog.ts`、`constants.ts`、`types.ts`(白名单);静态扫描自动守护(T14)

## R12 / R13 Discipline 概要

### R12 — Invocation Gate (5 个 precondition)

只在以下场景启动 ccbteam:

| ID | 场景 |
|---|---|
| `gate-multi-perspective` | 涉及伦理 / 估计 / 预测 / 主观判断,单视角不足 |
| `gate-single-stalled` | 主 agent 已多次自相矛盾或长期 hedge |
| `gate-cross-validation` | 用户**显式**要求 consensus / 共识 / cross-check |
| `gate-high-risk` | 影响安全 / 合规 / 生产 / 不可逆操作 |
| `gate-knowledge-boundary` | 主 agent 已识别 claim 落在自己训练知识边界外 |

详见 `.kiro/steering/ccbteam-invocation-discipline.md`(autoinclude)。

### R13 — Epistemic Honesty 5 条硬规则

每个 teammate 每轮**除了** `<cav>` 块,必须紧跟一个独立的 `<epistemic>` 自报块,5 字段 JSON。违反规则会被 sidecar 解析后写入 audit log:

| ID | 规则核心 |
|---|---|
| E1 | `outside` zone + 无 oracle → 必须显式 refuse |
| E2 | `training_cutoff_aware` 必须是 `YYYY-MM` 或 `'unknown'`,**禁止伪造** |
| E3 | 任何带数字/引文/URL/人名的主张,**必须**填 `claim_grounded_in` |
| E4 | `oracle_used` 与 `claim_grounded_in` 互不矛盾 |
| E5 | 上一轮被指出"越界" → 本轮 `repair_style ∈ {concede, split}` |

## Usage(给开发者)

### 跑单元 + PBT + 静态扫描

```bash
# Math Layer
bun test src/services/cav/ccbteam-math/__tests__/

# Discipline Layer
bun test src/services/cav/ccbteam-discipline/__tests__/

# 命令层(回归保护)
bun test src/commands/ccbteam/__tests__/

# Dashboard(零回归)
bun test src/services/cav/pev/dashboard/__tests__/

# Type check
bun run typecheck
```

### 启动 ccbteam(默认 observe 模式)

```
/ccbteam <claim>                            # 默认 observe — 挂 sidecar
/ccbteam --strategy=prompt-only <claim>     # 关掉所有数学层
/ccbteam --strategy=observe <claim>         # 显式开
/ccbteam --weights="lambdaCost=0.02" <claim># 调权重
/ccbteam --explain <claim>                  # 终端额外打印 ranking
/ccbteam --epsilon=0.05 <claim>             # ε_t 早停阈值(audit only)
```

被显式拒绝的形态:

```
/ccbteam --strategy=cr-eig ...        ← 报错:已被 R5 移除
/ccbteam --strategy=cr-eig+gtpo ...   ← 报错:已被 R5 移除
/ccbteam --weights="unknown=0.1" ... ← 报错:unknown key
```

### 输出位置

| 文件 | 内容 |
|---|---|
| `<sessionDir>/ccbteam-math-audit.jsonl` | append-only NDJSON,8 种事件类型 |
| 最终回执 markdown | `## Information Efficiency` + `### Knowledge Boundary Violations` |
| Dashboard 流(若 PEV dashboard 已启动) | `ccbteam.observer.cr-eig` / `.exploitability` / `.degradation` |

## Cross-References

- `.kiro/specs/super-agent-cluster/requirements.md` — R1..R13 全套验收条款
- `.kiro/specs/super-agent-cluster/design.md` — 5 段 Pinned Constants + 4 个 Algorithm 伪码
- `.kiro/specs/super-agent-cluster/tasks.md` — 20 个 task 实施进度
- `.kiro/steering/ccbteam-invocation-discipline.md` — R12 调用纪律(autoinclude)
- `src/services/cav/pev/dashboard/events.ts` — T12 新增 3 类事件类型
- [`docs/super-agent-cluster/case-studies/`](../../../../docs/super-agent-cluster/case-studies/README.md) — 真实场景操作日志(R12 / R13 实战印证)

---

**编号 codename**: `super-agent-cluster` | **数学算子**: CR-EIG / CAV-do | **公开命令**: `/ccbteam`

# Haking Code

> AI-powered terminal agent for cybersecurity professionals.

专为网络安全研究员打造的终端 AI Agent，集成逆向工程、渗透测试、多模型对抗共识等能力。

## v1.0.0 首次更新内容

- 🔐 **去登录化** — 移除 Anthropic OAuth，直接使用 API Key
- 🧠 **DeepSeek 默认接入** — base_url `https://api.deepseek.com/anthropic`
- 🎨 **全新 UI** — 侧边栏布局（Tasks / Memory / Buddy）
- ⚔️ **`/arena` 命令** — 4 链对抗共识引擎（C1 Proposer → C2 Challenger → C3 Verifier → C4 Synthesizer）
- 🔬 **`/recon` 命令** — PEV 假设驱动逆向分析引擎
- 🛠️ **ReverseCliTool** — 20+ 安全工具内置（nmap, nuclei, sqlmap, strings, diec...）
- ⚙️ **`/setup` 命令** — 持久化配置面板，支持多 Provider
- 🌐 **Firecrawl 集成** — Web 搜索作为外部真值锚点
- 📦 **183 个 Skills** — 安全扫描、代码审计、TDD、深度研究等
- 🐱 **Buddy 系统** — 宠物伴侣移至侧边栏

---

## 快速开始

### 环境要求

- [Bun](https://bun.sh/) >= 1.2.0
- DeepSeek API Key（https://platform.deepseek.com）

### 安装 & 运行

```bash
git clone https://github.com/elbelicojackson-hue/haking-code-.git
cd haking-code-
bun install
bun run dev
```

首次运行输入 `/setup` 配置 API Key，之后自动加载。

### 一键启动（Windows）

```bash
haking.bat
```

---

## 配置

### 方式一：`/setup` 命令（推荐）

在 REPL 中输入 `/setup`，交互式配置：

```
⚙ Haking Code 配置
  ~/.haking/config.json · 下次启动自动加载

▸ API Key:       sk-3a70...86ec
  Base URL:      https://api.deepseek.com/anthropic
  主模型:        deepseek-v4-pro
  快速模型:      deepseek-v4-flash
  Recon Providers [6]:  管理多 LLM →
  💾 保存配置
```

### 方式二：`.env` 文件

```env
ANTHROPIC_API_KEY=sk-xxx
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
FIRECRAWL_API_KEY=fc-xxx
```

### 方式三：环境变量

```bash
set ANTHROPIC_API_KEY=sk-xxx
set ANTHROPIC_MODEL=deepseek-v4-pro
set ANTHROPIC_SMALL_FAST_MODEL=deepseek-v4-flash
```

---

## 核心命令

| 命令 | 说明 |
|------|------|
| `/arena <问题>` | 4 链对抗共识 — 多角色辩论达成共识 |
| `/recon <binary>` | PEV 逆向分析 — 假设驱动的二进制分析 |
| `/setup` | 配置 API Key 和多 Provider |
| `/model` | 切换模型 |
| `/help` | 查看所有命令 |

---

## `/arena` — 4 链对抗共识

多个 AI 角色围绕一个问题进行结构化辩论，自动收敛到共识。

```bash
/arena 量子计算机能在 2028 年破解 RSA-2048 吗
/arena 这段代码有没有 SQL 注入漏洞
/arena Log4j 漏洞的根因是什么
```

### 4 条链

| Chain | 角色 | 职责 |
|-------|------|------|
| C1 | Proposer | 正向构建论点，寻找支持证据 |
| C2 | Challenger | 逻辑攻击，找漏洞和反例 |
| C3 | Verifier | 事实查证（带 Firecrawl 网页搜索） |
| C4 | Synthesizer | 综合收敛，标注共识和分歧 |

### 停止条件（纯信号驱动，无固定轮次）

- `consensus-reached` — 4 链全部标记 converged
- `no-new-evidence` — 所有链 update_kl < 0.05
- `gradient-quiet` — 连续 3 轮平均 update_kl < 0.03
- `confidence-plateau` — 平均置信度 > 0.9 且稳定
- `deadlock` — ≥2 条链声明死锁

---

## `/recon` — PEV 逆向分析引擎

假设驱动的二进制逆向分析循环。多 Agent 提出假设，调度安全工具验证，正则判定结果。

```bash
/recon ./malware.exe
/recon ./suspicious.dll "分析 C2 通信协议"
/recon ./packed.bin --max-rounds=10
```

### 假设类型（8 种）

| Kind | 示例 |
|------|------|
| `file-class` | PE32+ executable, 64-bit Windows |
| `packer` | Packed by UPX 4.0 |
| `compiler` | .NET / Mono assembly |
| `family` | Emotet variant |
| `algorithm` | AES-256-CBC for C2 encryption |
| `anti-analysis` | TLS callback anti-debug |
| `capability` | Network C2 via HTTPS |
| `protocol` | gRPC over HTTP/2 |

### 工具白名单

`ReverseCli` | `Bash` | `Read` | `Grep` | `WebSearch` | `Firecrawl`

### 停止条件

- `all-resolved` — 无 open 假设
- `budget-cap-hit` — 轮次/工具/token/时间预算耗尽
- `stall-guard-hit` — 连续 2 轮所有 agent observe-only
- `parse-storm` — ≥50% agent 解析失败
- `user-abort` — Esc 取消

---

## ReverseCliTool — 内置安全工具箱

AI 可直接调用的 20+ 安全工具：

| Action | 工具 | 用途 |
|--------|------|------|
| `strings` | strings | 提取字符串 |
| `analyze` | file | 文件类型识别 |
| `diec` | Detect It Easy | 壳/保护检测 |
| `upx` | UPX | 脱壳 |
| `pentest` | nuclei/nmap/sqlmap/ffuf | 渗透测试 |
| `kali` | 任意命令 | Kali 工具链 |
| `tshark` | tshark | 网络抓包分析 |
| `forensic` | curl | Web 取证 |

### 渗透测试子工具

```bash
# AI 会自动调用：
ReverseCli({action: "pentest", pentestTool: "nmap", pentestArgs: "-sV 192.168.1.1"})
ReverseCli({action: "pentest", pentestTool: "nuclei", pentestArgs: "-u https://target.com"})
ReverseCli({action: "pentest", pentestTool: "sqlmap", pentestArgs: "-u 'http://target/page?id=1'"})
```

---

## 多 Provider 配置（Recon/Arena）

`/setup` → Recon Providers 管理，支持混合不同厂商 LLM：

```
🔗 Recon Providers（多 LLM 对抗分析）

▸ gpt5-thinker → gpt-5.4 (yunwu.ai)
  claude-challenger → claude-opus-4-6 (yunwu.ai)
  deepseek-verifier → deepseek-chat (api.deepseek.com)
  qwen-analyst → qwen-max (dashscope.aliyuncs.com)
  doubao-scout → doubao-seed-2-0-pro (ark.cn-beijing.volces.com)
  mimo-backup → mimo-v2.5-pro (api.xiaomimimo.com)
  [+ 添加 Provider]
```

自动检测协议：
- URL 含 `/anthropic` → Anthropic Messages API
- 其他 → OpenAI Chat Completions API

---

## 算法架构

```
src/algorithms/
├── cav/
│   ├── pev/                 # PEV 引擎（假设-执行-验证循环）
│   ├── ccbteam-math/        # 纯观测数学层（CR-EIG, ε_t, ρ_t）
│   └── ccbteam-discipline/  # 认知纪律层（R12 调用门 + R13 认知诚实）
├── ccb-pev/                 # /recon 命令 UI
└── ReverseCliTool/          # PentAGI 安全工具箱（Go 后端）
```

### ccbteam-math 核心算法

| 算法 | 作用 |
|------|------|
| CR-EIG | 信息效率主算子 |
| exploitability (ε_t) | 博弈论一阶可利用度 |
| urgency (ρ_t) | 共识紧迫度 = 1 − ε_t |
| rankGradients | 5 个 ∇H 排序（attack/swap/oracle/chain/discretize） |
| cavAdaptiveDelta | 自适应收敛阈值 |

**设计红线**：Math Layer 只测量不干预，不写 prompt，不形成闭环。

---

## UI 布局

```
┌──────────────┬─────────────────────────────────────┐
│ ▾ Tasks      │  主聊天区                             │
│  ☐ task1     │                                      │
│  ☑ task2     │  > 你的输入                           │
│              │                                      │
│ ▾ Memory     │  Haking: 回复...                     │
│  • CLAUDE.md │                                      │
│              │                                      │
│ ▾ Buddy      │                                      │
│  🐱 Mochi    │                                      │
│              ├──────────────────────────────────────┤
│              │  > _                                  │
└──────────────┴──────────────────────────────────────┘
```

- `Ctrl+B` 切换侧边栏
- 终端宽度 < 80 列自动隐藏

---

## 开发

```bash
bun run dev          # 开发模式
bun run build        # 构建到 dist/
bun run dev:inspect  # 调试模式（VS Code attach）
bun test             # 运行测试
```

## 法律声明

本工具仅供合法安全研究和教育用途。详见 [LEGAL.md](./LEGAL.md)。

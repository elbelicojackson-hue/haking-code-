# Haking Code

> AI-powered terminal agent for cybersecurity professionals.

专为网络安全研究员打造的终端 AI Agent，集成逆向工程、渗透测试、多模型对抗共识等能力。

## 📋 更新日志（v1.1.0 → v1.1.1 hotfix）

> 以下为 v1.0.1 之后的全部 commit 摘要，按时间倒序。

### `669d09b` fix(deepseek): normalize messages before sending to direct route

**根因**：DeepSeek 直连路径拿到的是原始 messages 数组，跳过了 `normalizeMessagesForAPI()` + `ensureToolResultPairing()` 两个关键处理步骤。几轮工具调用后 messages 里出现 API 不认识的内部字段和不配对的 tool_result，导致 DeepSeek 返回 400 或空响应——表现为"对话几轮后不回复"。

**修复**：`claude.ts` 调用 `queryModelDeepSeekDirect` 前先走 `normalizeMessagesForAPI` + `ensureToolResultPairing`，与 SDK 路径同一套清洗逻辑。

---

### `c5780f9` fix(deepseek): don't inject cache_control on tool_result blocks + surface empty responses

1. **cache_control 注入修复**：之前给最后一条 user 消息的最后一个 content block 无差别加 `cache_control`，如果那个 block 是 `tool_result` 类型，DeepSeek 会返回 400。现在只给 `type: 'text'` 的 block 加。
2. **空响应不再静默**：如果 DeepSeek 返回 0 content blocks + 0 output tokens，显示 `[DeepSeek returned empty response]` 并附带诊断提示（上下文过长 / tool_result 格式错误），而不是一条空消息。

---

### `8667548` fix: guard msg.message?.content access with optional chaining

`src/components/Messages.tsx` 两处 `msg.message?.content[0]` → `msg.message?.content?.[0]`。system / attachment 等消息没有 `.message.content` 字段，直接 `[0]` 会 TypeError crash。

---

### `8d8882a` docs: add Wiki section to README — emphasize Firecrawl API Key requirement

README 新增 "📚 Haking Wiki" 段落，强调爬虫功能**必须自行配置 Firecrawl API Key**（获取地址、三种配置方式、免费额度说明）。

---

### `ec54de7` feat(wiki): P0 knowledge graph + Web UI (v1.0.0)

全新 `wiki/` 目录（9 文件，1512 行）：

| 模块 | 文件 | 功能 |
|------|------|------|
| 数据层 | `core/graph.ts` | WikiGraph 类：节点/边 CRUD、graph.json 持久化（单写队列防并发）、subscribe/emit delta、子串搜索 |
| 爬取层 | `core/crawler.ts` | Firecrawl scrape → Turndown 回退 → `.haking/wiki/pages/{id}.md`，自动 upsert page 节点 |
| HTTP | `server.ts` | Bun.serve port 7891，静态文件 + REST + WS + markdown 页面服务 |
| REST | `routes/api.ts` | 8 个 endpoint（nodes/edges CRUD + search + snapshot） |
| WebSocket | `routes/ws.ts` | 连接即推 snapshot，后续 delta 实时广播；客户端可 crawl/search/ping |
| 前端 | `web/index.html` | 三栏布局（工具栏 / D3 画布 / Markdown 面板） |
| 可视化 | `web/graph.js` | D3 force-directed 图，增量 delta 更新，搜索高亮，节点选中 → 右侧 markdown 预览 |
| 样式 | `web/style.css` | 赛博朋克暗色主题（与灵动岛同色系 #00fff7 / #a855f7 / #ff2d95） |

启动：`cd wiki && bun run dev` → http://localhost:7891

---

### `55a5918` feat(island): tools launcher + wt.exe split-pane + drag fix (v1.1.0)

灵动岛 Tauri 2 项目首次入库（`island/` 目录，10 文件，768 行）：

- **拖拽修复**：补 `capabilities/default.json`（6 条 window 权限）+ `withGlobalTauri: true` + mousedown 显式 `startDragging()`
- **三连击关闭**：`MouseEvent.detail >= 3` → `close()`
- **CLI 工具启动器**：6 个默认工具（Haking / OpenCode / Codex / Claude / Aider / Gemini），每个一种品牌色圆球，配置存 `%APPDATA%\haking-island\tools.json`
- **wt.exe 分屏**：Shift+多选 ≥2 工具 → 点 Layout 按钮 → 一行 `wt new-tab ... ; split-pane ...` 原生分屏（4 种 layout：左右 / 上下 / 田字 / 多 Tab）
- **无 wt.exe 回退**：每工具独立 cmd 窗口

---

### `4969433` feat(deepseek): full overhaul + multi-instance island hub (v1.1.0)

**DeepSeek 直连路径完全重写**（`src/services/api/deepseek-direct.ts`，672 行）：

| 项 | 之前 | 现在 |
|---|---|---|
| 流式输出 | `await res.json()` 阻塞 | SSE `stream:true`，emit Anthropic 标准事件 |
| 工具 schema | 空 `{type:'object', properties:{}}` | `zodToJsonSchema(tool.inputSchema)` 真实 schema |
| 工具数量 | `slice(0, 20)` 静默丢 | 全部传入 |
| max_tokens | 硬编码 8192 | 64K 默认 / 384K 上限 |
| temperature | 没传 | pass-through |
| 思考模式 | 不请求 | `thinking:{type:'enabled'}` plumbing |
| cache_control | 无 | system 尾 + user 尾 + tool 列表尾 |
| 重试 | 无 | 429/5xx 指数退避 3× |
| 错误分类 | 一行文本 | 解析 `{error:{type,message}}`，401/429/500 各自提示 |
| tool_use | 解析但不 yield | 完整 yield |

**上下文 / 价格 / 容量**：
- DeepSeek V4 上下文 200K → 1M
- 输出上限 default 64K / upper 384K
- `modelCost.ts` 加 DeepSeek 三档 USD 价表，`unknown_model_cost` 告警熄灭

**ModelStatsPanel 增强**：
- `DEEPSEEK_PRO_FULL_PRICE=1` 切换 pro 原价/2.5 折
- 累计行加 USD 等价

**灵动岛多实例聚合**（`src/services/island.ts`）：
- 每实例写 `~/.haking-island/sessions/{pid}.json`
- 抢 port 7890 当 hub → 读全部 session 文件聚合广播
- 非 hub 30s 重试抢占；hub 死后无缝接管
- 岛上 sessions 列表显示所有活实例

---

## ⚠️ DeepSeek 兼容性修复

本项目完全绕过 Anthropic SDK（`@anthropic-ai/sdk`）的 Zod v4 校验层，使用原生 `fetch` 直连 DeepSeek API。原因：Anthropic SDK 0.80+ 对响应格式有严格的 schema 校验（`_idmap`、`schema._zod` 等），DeepSeek 的兼容 API 不返回这些私有字段，导致运行时崩溃。

**解决方案**：`src/services/api/deepseek-direct.ts` 在 `queryModel` 入口处拦截，不经过 SDK，直接用 fetch 调用 `/v1/messages` 端点，手动构造 `AssistantMessage` 返回给下游消费者。

## 🚀 v1.1.0 — DeepSeek 全面优化 + 灵动岛工具启动器

本次发布把 DeepSeek 路径从"能跑"升级到"能跑得好"，并把灵动岛升级成 AI CLI 工具的总控面板。

### DeepSeek 核心优化（`src/services/api/deepseek-direct.ts` 重写）

| 改动 | 之前 | 现在 |
|------|------|------|
| **流式输出** | `await res.json()`（阻塞，整段返回） | SSE `stream: true`，emit Anthropic 标准事件 (`message_start` / `content_block_delta` / `message_stop`)，token 级渐进显示 |
| **工具 input_schema** | 全部硬编码空 schema `{type:'object', properties:{}}` | `zodToJsonSchema(tool.inputSchema)` 真实 schema |
| **工具数量** | 静默 `slice(0, 20)` 砍掉 21 号之后 | 全部传入 |
| **`max_tokens`** | 硬编码 8192 | `getModelMaxOutputTokens()` + `CLAUDE_CODE_MAX_OUTPUT_TOKENS` env 覆盖；DeepSeek V4 默认 64K（最大支持 384K） |
| **temperature** | 没传 | 从 `options.temperature` pass-through |
| **思考模式** | parse 但从不请求 | `thinking: {type:'enabled', budget_tokens}` plumbing 通了 |
| **`cache_control`** | 完全没用 | 系统块尾、最后 user 消息、tool 列表尾全部标 `ephemeral`，DeepSeek 缓存命中输入价低 50× |
| **重试** | 失败一次就死 | 429 / 5xx / 网络错误 → 指数退避 800/1600/3200ms，最多 3 次 |
| **错误分类** | 一行 `${status}: ${text}` | 解析 `{error:{type,message}}`，401/429/500 各自带提示与下一步操作 |
| **`tool_use` 块** | 解析了但**从来没 yield**（Agent 工具调用静默失败） | 完整 yield + `cache_creation_input_tokens` 计入 |

### 上下文 / 价格 / 容量（`src/utils/context.ts` + `modelCost.ts`）

- DeepSeek V4 上下文窗 `200K → 1M`（`modelSupports1M` 加 deepseek-v4 匹配）
- DeepSeek V4 输出上限 `default 64K / upper 384K`
- `MODEL_COSTS` 加 DeepSeek 三档专属表（按官方人民币价折 USD），`getModelCosts` short-circuit 不再走 Claude 错档
- `tengu_unknown_model_cost` 告警熄灭，StatusLine "costs may be inaccurate" 不再亮

### 实时计费面板（`src/components/PromptInput/ModelStatsPanel.tsx`）

输入框正下方常驻：

```
deepseek-v4-flash   in 12.3k · out 4.5k · cache↓ 8.0k · cache↑ 0   ¥0.0123 (1/2 ¥/Mtok)
deepseek-v4-pro     in 0     · out 0    · cache↓ 0    · cache↑ 0   ¥0      (3/6 ¥/Mtok)
累计 ¥0.0123 (≈ $0.0017) · pro 当前 2.5 折，原价 12/24 ¥/Mtok
```

- 直接按 DeepSeek 官方人民币单价算 CNY，1 秒轮询 `STATE.modelUsage`
- 累计行带 USD 等价（汇率 7.2）
- 设 `DEEPSEEK_PRO_FULL_PRICE=1` → 切到 pro 原价档（pricing 同步进 modelCost.ts）
- 仅 `ANTHROPIC_BASE_URL` 含 `deepseek` 时显示，其他后端隐藏避免误导
- 终端宽度 < 70 列自动隐藏

### 灵动岛多实例聚合（`src/services/island.ts`）

之前两个 Haking Code 同时跑，第二个抢不到 port 7890 就**完全隐形**，岛上只显示一个 session。现在改成文件聚合 + 端口领导选举：

```
每个 Haking Code 实例
  ├─ 写 ~/.haking-island/sessions/{pid}.json，每 1.5s 刷新
  ├─ 抢 port 7890
  │   ├─ 成功 → 当 hub：每秒读全部 session 文件聚合广播
  │   └─ 失败 → 仅写文件（30s 重试一次抢占）
  └─ exit/SIGINT/SIGTERM → 删自己的文件

Hub 读文件时 mtime > 8s 视为死亡 → unlink
第一个 hub 死 → 30s 内第二个无缝接管
```

岛上 sessions 列表会列出所有活实例，每条带 cwd 区分（`Haking Code (miserad)` / `Haking Code (myproject)`），底部 stats 是聚合值。

## 🏝️ 灵动岛 v1.1.0（`island/`）

### 拖拽修复（v1.0 完全拖不动）

根因两个：
1. `src-tauri/capabilities/` 目录根本没建，Tauri 2 严格安全模型默认拒绝 `core:window:allow-start-dragging`
2. `tauri.conf.json` 没设 `withGlobalTauri: true`，v2 默认 `false` 导致 `window.__TAURI__` 全局对象不存在，HTML 第一行 `const { invoke } = window.__TAURI__.core` 直接 TypeError，整个 script 静默挂掉

修复：建 `capabilities/default.json` 释放 6 条 window 权限；conf 加 `withGlobalTauri: true`；HTML 用 `mousedown → startDragging()` 显式拖拽（比 `data-tauri-drag-region` 在 transparent + decorations:false 组合下更稳）。

### 三连击关闭

`MouseEvent.detail >= 3` 触发 `getCurrentWindow().close()`，跟 OS 双击间隔同步。

### CLI 工具启动器 + wt.exe 分屏

展开后多了两个区：

```
┌──────────────────────────────────┐
│ ▾ Sessions                       │
│   ● Haking Code (miserad)        │  ← 多实例 each cwd
│   ● Haking Code (myproject)      │
├──────────────────────────────────┤
│ ▾ TOOLS  click 启动 · shift 多选 │
│   🟦 Haking  🟧 OpenCode         │
│   🟢 Codex   🟫 Claude           │
│   🩷 Aider   🟦 Gemini           │
├──────────────────────────────────┤
│ ▾ LAYOUT                         │
│   [▮▮ 左右] [≡ 上下] [⊞ 田字] [▤ Tab]│
└──────────────────────────────────┘
```

每个工具一个品牌色小圆球。配置文件 `%APPDATA%\haking-island\tools.json`，首次启动自动写默认 6 工具，可自由编辑加自家 CLI / 命令参数 / cwd。

**单击** → `wt.exe new-tab` 启动单个；**Shift+多选 ≥2 个 + 点 layout 按钮** → 一行 `wt new-tab ... ; split-pane -V ... ; split-pane -H ...` 把它们 split-pane 到同一个 Windows Terminal 窗口，原生分屏。

四种 layout：
- **左右**：垂直 split-pane 链
- **上下**：水平 split-pane 链
- **田字**：4 工具时正好 2×2 quadrant，别的数量退化成左右
- **多 Tab**：每个工具一个 wt tab，不分屏

没装 wt.exe 的老 Windows → 回退到每工具一个独立 cmd 窗口。

## 📚 Haking Wiki — 知识图谱

`wiki/` 目录是一个独立的 Bun 应用，提供安全研究知识图谱 + D3 力导向可视化 + Markdown 预览。

```bash
cd wiki && bun run dev
# → http://localhost:7891
```

> ⚠️ **爬虫功能需要自行配置 Firecrawl API Key**
>
> Wiki 的 "Add Page" 功能通过 [Firecrawl](https://firecrawl.dev) 爬取网页并转为 Markdown。**必须先获取 API Key 并配置到环境变量**，否则爬取会失败（回退到原生 fetch + Turndown，但对 JS 渲染页面效果差）。
>
> ```bash
> # 方式 1：.env 文件（项目根目录）
> FIRECRAWL_API_KEY=fc-xxxxxxxxxxxxxxxx
>
> # 方式 2：环境变量
> set FIRECRAWL_API_KEY=fc-xxxxxxxxxxxxxxxx
>
> # 方式 3：/setup 命令配置（Haking Code 内）
> ```
>
> 获取 Key：https://firecrawl.dev → 注册 → Dashboard → API Keys
>
> 免费额度：500 次/月，足够日常研究使用。

---

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

### 本地工具安装要求

部分工具需要本地安装并加入 PATH，AI 才能调用：

| 工具 | 安装方式 | 备注 |
|------|----------|------|
| IDA Pro | 自行获取安装，将 `idat64.exe` 加入 PATH | 无头模式分析 |
| Ghidra | https://ghidra-sre.org/ 下载解压 | 需要 JDK 17+ |
| Detect It Easy (DiE) | https://github.com/horsicq/DIE-engine/releases | 壳检测必备 |
| UPX | `scoop install upx` 或官网下载 | 脱壳 |
| nmap | https://nmap.org/download | 端口扫描 |
| nuclei | `go install github.com/projectdiscovery/nuclei/v3/cmd/nuclei@latest` | 漏洞扫描 |
| sqlmap | `pip install sqlmap` | SQL 注入 |
| ffuf | `go install github.com/ffuf/ffuf/v2@latest` | 目录爆破 |
| tshark | 安装 Wireshark 自带 | 抓包分析 |
| strings | Windows: 安装 Binutils 或 SysInternals Strings | 字符串提取 |
| Frida | `pip install frida-tools` | 动态脱壳/Hook |

> 💡 没装的工具不影响其他功能，AI 会跳过不可用的工具并使用替代方案。

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
│              │  flash  in 0 · out 0 · cache 0   ¥0  │
│              │  pro    in 0 · out 0 · cache 0   ¥0  │
│              │  累计 ¥0 · pro 当前 2.5 折            │
└──────────────┴──────────────────────────────────────┘
```

- `Ctrl+B` 切换侧边栏
- 终端宽度 < 80 列自动隐藏侧边栏；< 70 列自动隐藏计费面板
- 计费面板每秒轮询一次 `STATE.modelUsage` 累加值（cost-tracker 在 React 之外 mutate 全局，没有事件订阅）

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

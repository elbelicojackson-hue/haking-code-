# Haking Code 下一版本进阶方案

> 参考来源：[can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)（5.8k ⭐，2026.05 GitHub Trending）

---

## 1. Hash 锚定编辑（Hashline Edit）

**参考实现：** https://github.com/can1357/oh-my-pi  
**相关文档：** README > `09 · Hashline: edit by content hash`

### 问题

当前 Haking Code 的文件编辑依赖行号定位。当文件被修改后，行号偏移导致编辑位置错误，agent 需要反复重试，浪费 token。

### 方案

用**内容 hash** 替代行号作为编辑锚点：

1. agent 提交编辑时，附带目标代码片段的 hash（而非行号）
2. 编辑器在文件中搜索匹配该 hash 的内容块
3. 找到后执行替换；若 hash 不匹配（文件已变更），直接拒绝，不产生错误编辑

```typescript
// 伪代码示意
interface HashlineEdit {
  anchor: string      // 目标内容的 hash（如 sha256 前8位）
  context: string     // 锚点周围的原始内容（用于定位）
  replacement: string // 替换内容
}

function applyHashlineEdit(file: string, edit: HashlineEdit) {
  const content = readFile(file)
  const anchorPos = findByContentHash(content, edit.anchor, edit.context)
  if (!anchorPos) throw new Error('Stale anchor: file has changed, edit rejected')
  return splice(content, anchorPos, edit.replacement)
}
```

### 收益

- oh-my-pi 实测：Grok 4 Fast 输出 token 减少 **61%**
- 消除"行号偏移"导致的错误编辑
- 特别适合 `/recon` PEV 循环中对二进制分析结果的标注编辑

---

## 2. Hindsight 跨 Session 记忆系统

**参考实现：** https://github.com/can1357/oh-my-pi  
**相关文档：** README > `11 · Hindsight: memory the agent curates`

### 问题

当前每次启动 Haking Code 都是全新 session，agent 不记得上次的分析结论、目标信息、已发现的漏洞等，需要重复输入上下文。

### 方案

三层记忆 API：

| 操作 | 说明 | 触发时机 |
|------|------|---------|
| `retain(fact)` | 写入持久化事实到记忆库 | agent 发现重要信息时主动调用 |
| `recall(query)` | 语义搜索记忆库 | session 开始或需要历史信息时 |
| `reflect(question)` | 基于记忆库综合推理 | 需要跨 session 分析时 |

**存储结构：**

```
.haking/
  memory/
    <project-hash>/       # 按项目隔离
      facts.jsonl         # 原始事实流
      index.db            # 向量索引（用于 recall 语义搜索）
      summary.md          # 每次 session 结束后压缩的摘要
```

**与现有功能的结合：**

- `/recon` PEV 循环结束后，自动 `retain` 关键假设和验证结论
- `/arena` 共识结果自动写入记忆，下次同类目标直接 `recall`
- session 启动时自动加载项目记忆摘要作为初始上下文

### 实现优先级

1. **Phase 1**：简单的 `facts.jsonl` + 关键词搜索（1-2天）
2. **Phase 2**：向量嵌入 + 语义 `recall`（接入 DeepSeek embedding API）
3. **Phase 3**：session 结束自动压缩 + `reflect` 综合推理

---

## 参考仓库

| 项目 | 链接 | 关键参考点 |
|------|------|-----------|
| oh-my-pi | https://github.com/can1357/oh-my-pi | Hash锚定编辑、Hindsight记忆、时间流规则注入 |
| oh-my-pi SDK | https://github.com/can1357/oh-my-pi/tree/main/packages | `pi-agent-core` 的工具调用架构 |

---

*记录时间：2026-05-22*


---

## 3. 多 Agent 分工协作（multica 模式）

**参考实现：** https://github.com/multica-ai/multica  
**相关文档：** README > 任务分发、Skills 复用

### 问题

当前 `/arena` 是 4 个 agent 对**同一个问题**做对抗共识，适合提升单个答案质量。但面对复杂渗透测试任务（如：信息收集 → 漏洞扫描 → 利用 → 报告），各阶段需要**并行分工**而非串行执行。

### 方案

在 `/arena` 之上增加任务编排层：

```
用户输入复杂任务
    ↓
任务分解器（Planner agent）
    ↓
┌─────────────────────────────────┐
│  子任务1: 信息收集              │
│  子任务2: 端口扫描              │  ← 并行执行
│  子任务3: 漏洞识别              │
└─────────────────────────────────┘
    ↓
每个子任务内部走 /arena 共识
    ↓
结果汇总 → 最终报告
```

**新增命令：** `/mission`

```
/mission "对 192.168.1.0/24 进行完整渗透测试"
```

**动态 Skill 生成：**
参考 multica 的 Skills 复用机制——每次成功完成的子任务，自动抽象成 Skill 文件写入 `.claude/skills/`，下次同类任务直接复用，不重复推理。

### 与现有功能结合

| 现有功能 | 新增功能 | 组合效果 |
|---------|---------|---------|
| `/arena` 4链共识 | 任务分解器 | 复杂任务拆分后每步都有质量保证 |
| `ReverseCliTool` | 并行子agent | 多个工具同时运行，结果汇总 |
| `.claude/skills/` | 动态Skill生成 | 经验自动积累，越用越聪明 |

### 参考仓库

| 项目 | 链接 |
|------|------|
| multica | https://github.com/multica-ai/multica |

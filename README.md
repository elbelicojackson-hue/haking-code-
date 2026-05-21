# Haking Code

AI-powered terminal coding assistant，默认接入 DeepSeek API。

## ⚡ 快速开始

### 环境要求

- [Bun](https://bun.sh/) >= 1.2.0
- DeepSeek API Key（从 https://platform.deepseek.com 获取）

### 安装依赖

```bash
bun install
```

### 运行

```bash
# 设置 API Key
set ANTHROPIC_API_KEY=你的deepseek-api-key

# 开发模式
bun run dev

# 构建
bun run build
```

构建产物输出到 `dist/` 目录，bun 和 node 都可以启动。

### NPM 安装（构建后发布）

```sh
npm i -g haking-code

haking    # 以 node 启动
haking-bun # 以 bun 启动
hk        # 简写
```

## 默认配置

| 配置项 | 默认值 |
|--------|--------|
| Base URL | `https://api.deepseek.com/anthropic` |
| 主模型 (Sonnet/Opus) | `deepseek-v4-pro` |
| 快速模型 (Haiku) | `deepseek-v4-flash` |

可通过环境变量覆盖：

```bash
set ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
set ANTHROPIC_API_KEY=sk-xxx
set ANTHROPIC_MODEL=deepseek-v4-pro
set ANTHROPIC_SMALL_FAST_MODEL=deepseek-v4-flash
```

## Feature Flags

通过 `FEATURE_<FLAG_NAME>=1` 环境变量启用功能：

```bash
FEATURE_BUDDY=1 FEATURE_FORK_SUBAGENT=1 bun run dev
```

## VS Code 调试

1. 终端启动：`bun run dev:inspect`
2. VS Code F5 → 选择 "Attach to Bun (TUI debug)"

## 许可证

仅供学习研究用途。

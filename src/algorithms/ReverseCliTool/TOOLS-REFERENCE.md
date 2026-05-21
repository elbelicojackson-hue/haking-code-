---
title: "ReverseCliTool 工具参考"
tags: ["reverse-engineering", "tools", "ida", "ghidra", "pentest"]
created: "2026-04-30T00:00:00.000Z"
updated: "2026-04-30T00:00:00.000Z"
---

# ReverseCliTool 工具参考

## 概述

ReverseCliTool 是 HACKERT LING 的核心逆向工程工具，集成了 20+ 种安全/逆向工具的 CLI 自动化能力。

源码位置: `packages/builtin-tools/src/tools/ReverseCliTool/`

## 支持的 Action

| Action | 用途 | 必需参数 |
|--------|------|----------|
| `analyze` | 通用二进制分析 | `targetPath` |
| `strings` | 提取字符串 | `targetPath` |
| `dump` | 二进制转储 | `targetPath` |
| `ida` | IDA Pro 无头分析 | `targetPath`, `idaArgs` |
| `ghidra` | Ghidra 无头反编译 | `targetPath` |
| `diec` | Detect It Easy 壳检测 | `targetPath`, `diecArgs` |
| `upx` | UPX 脱壳 | `targetPath`, `upxArgs` |
| `radamsa` | 模糊测试 | `targetPath`, `radamsaArgs` |
| `tshark` | 网络抓包 | `tsharkArgs` |
| `pentest` | 渗透测试工具 | `pentestTool`, `pentestArgs` |
| `cs2dumper` | CS2 内存转储 | - |
| `pslist` | 进程列表 | - |
| `kali` | Kali Linux 命令 | `kaliCmd` |
| `mitm-capture` | MITM 代理抓包 | - |
| `ai-analyze` | AI 流量分析 | `analysisSessionId` |
| `llm-audit` | LLM 安全审计 | `llmAuditModule`, `llmAuditTarget` |
| `forensic` | Web 取证 | `forensicUrl` |
| `frida-unpack` | Frida 脱壳 | `fridaApp` |
| `shell-protect` | 壳分析 | `targetPath` |
| `vmp-ref` | VMProtect 参考 | - |
| `pentagi-agent` | PentAGI 集群部署 | - |

## 渗透测试子工具

通过 `action="pentest"` 调用：

- **nuclei**: 漏洞扫描（模板驱动）
- **nmap**: 端口扫描
- **httpx**: HTTP 探测与指纹
- **ffuf**: 目录/路径模糊测试
- **sqlmap**: SQL 注入自动化
- **subfinder**: 子域名枚举
- **naabu**: 快速端口扫描

## LLM 审计模块

通过 `action="llm-audit"` 调用：

- `encoding`: 编码绕过
- `persona`: 角色扮演攻击
- `crescendo`: 渐进式攻击
- `multilingual`: 多语言攻击
- `indirect`: 间接注入
- `pair`: 双角色攻击
- `gcg`: 梯度对抗攻击
- `scan`: 综合扫描

## 关键文件

```
ReverseCliTool/
├── ReverseCliTool.ts    # 主工具定义（buildTool）
├── prompt.ts            # 工具描述
├── UI.tsx               # 终端 UI 组件
├── pentestCommands.ts   # 渗透工具配置
├── llmAuditCommands.ts  # LLM 审计模块
├── tsharkCommands.ts    # tshark 配置
└── pentagi/             # PentAGI 集群部署
```

## 使用模式

所有工具遵循统一模式：
1. `action` 选择操作类型
2. 相关参数提供工具特定配置
3. `targetPath` 指定目标文件
4. 工具路径参数（如 `idaPath`）可覆盖默认 PATH 查找

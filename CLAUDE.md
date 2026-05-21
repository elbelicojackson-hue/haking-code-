# CLAUDE.md

This file provides guidance to Haking Code when working in this repository.

## Identity

You are **Haking Code** — an AI-powered terminal agent for cybersecurity professionals. You specialize in penetration testing, vulnerability analysis, reverse engineering, and security automation.

## Project Overview

This is Haking Code, a terminal AI agent built for security researchers. Key features:
- DeepSeek API backend (Anthropic Messages API compatible)
- `/arena` — 4-chain adversarial consensus (C1 Proposer, C2 Challenger, C3 Verifier, C4 Synthesizer)
- `/recon` — PEV hypothesis-driven reverse engineering
- `ReverseCliTool` — 20+ built-in security tools (nmap, nuclei, sqlmap, strings, diec, etc.)
- Sidebar UI with Tasks, Memory, Buddy panels

## Tech Stack

- Runtime: Bun
- Language: TypeScript
- UI: React + @anthropic/ink (terminal renderer)
- Build: Bun.build with code splitting
- API: DeepSeek via Anthropic-compatible endpoint

## Key Directories

- `src/algorithms/cav/pev/` — PEV engine (hypothesis-execute-verify loop)
- `src/algorithms/cav/ccbteam-math/` — Pure observer math layer (CR-EIG)
- `src/algorithms/ReverseCliTool/` — PentAGI security toolbox
- `src/commands/arena/` — 4-chain consensus command
- `src/commands/setup/` — Configuration panel
- `src/components/Sidebar/` — Sidebar UI
- `src/services/api/deepseek-direct.ts` — Direct API route (bypasses SDK)

## Commands

```bash
bun run dev          # Development
bun run build        # Production build
bun test             # Tests
```

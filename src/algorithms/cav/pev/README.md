# PEV — Plan-Execute-Verify Loop for Reverse Engineering

> `/ccb-pev <binary> [goal] [--max-rounds=N] [--max-tools=N]`

PEV is a hypothesis-driven execution loop that externalises RE reasoning into a typed **Hypothesis Bank + Evidence Ledger**, driven by a deterministic scheduler rather than model memory. Agents propose hypotheses, the runner dispatches canonical tool plans, and a regex verdict engine auto-judges results — all without LLM-in-the-loop judgement.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  /ccb-pev command (ccb-pev.tsx)                                 │
│    ├─ parseArgs → validate binary → sha256 → load providers     │
│    └─ mount <PevSession /> (Ink)                                │
│         └─ for await (runPev(opts)) → render events             │
├─────────────────────────────────────────────────────────────────┤
│  PevRunner (pevRunner.ts) — async generator main loop           │
│    round N:                                                     │
│      1. schedule(ledger, agents, round)                         │
│      2. propagate(ledger, agents, round)                        │
│      3. buildPrompt per agent → dispatchArena                   │
│      4. parsePevOutput (3-layer fallback)                       │
│      5. applyHypothesisUpdate (reducer)                         │
│      6. execute tool_call → judgeVerdict → appendEvidence       │
│      7. persistence (writePevEvalLog)                           │
│      8. stop-condition check                                    │
├─────────────────────────────────────────────────────────────────┤
│  Pure-function leaves (no I/O, no state):                       │
│    protocol.ts    — zod schemas + types                         │
│    validator.ts   — cross-validation (referential integrity)    │
│    parser.ts      — 3-layer fault-tolerant parse                │
│    ledger.ts      — immutable reducer (hypothesis + evidence)   │
│    canonicalTests.ts — const tool-plan table (24+ entries)      │
│    verdict.ts     — regex verdict engine                        │
│    scheduler.ts   — per-agent directive assignment              │
│    propagator.ts  — cross-agent inbox builder                   │
│    promptBuilder.ts — system + user prompt assembly             │
│    persistence.ts — atomic .pev.json writer                     │
└─────────────────────────────────────────────────────────────────┘
```

## Protocol Overview

Each agent outputs three sections per round (fixed order):

1. `## 1. 内容` — free-text reasoning
2. `` ```pev `` — JSON object conforming to `PevOutputSchema`
3. `` ```cav `` — existing CAV self-report (unchanged)

The `pev` block carries:
- `schema_version`: literal `"1.0"`
- `agent_id`: must match the assigned id
- `round`: must match current round
- `observations[]`: cite existing evidence
- `hypothesis_updates[]`: 5 ops — `create | promote | falsify | mutate | confidence_adjust`
- `next_action`: 4 kinds — `tool_call | observe_only | request_oracle | declare_done`

## Hypothesis Kinds (8)

| Kind | Example claim |
|------|---------------|
| `file-class` | "PE32+ executable, 64-bit Windows" |
| `packer` | "Packed by UPX 4.0" |
| `compiler` | ".NET / Mono assembly" |
| `family` | "Emotet variant" |
| `algorithm` | "Uses AES-256-CBC for C2 encryption" |
| `anti-analysis` | "TLS callback anti-debug" |
| `capability` | "Network C2 via HTTPS" |
| `protocol` | "gRPC over HTTP/2" |

## Canonical Test Plans

Plans are defined in `canonicalTests.ts` as a module-level const table. Each plan specifies:

```typescript
{
  id: 'packer::diec',           // <kind>::<slug>
  kind: 'packer',
  tool: 'ReverseCli',           // one of 6 allowed tools
  base_args: { action: 'diec', diecArgs: ['-e', '-r'] },
  overridable_fields: ['targetPath', 'diecArgs'],
  confirms: [/UPX|VMProtect|Themida/i],
  falsifies: [/not\s+packed/i],
  timeout_ms: 30_000,
  cost_estimate: 'small',
  description: 'Detect It Easy packer/protector scan',
}
```

**Tool Allowlist** (fixed, 6 items): `ReverseCli | Bash | Read | Grep | WebSearch | Firecrawl`

### Adding a New ToolPlan

1. Open `src/services/cav/pev/canonicalTests.ts`
2. Add a new entry to `CANONICAL_TESTS` with a unique `<kind>::<slug>` id
3. Ensure `tool` is in the allowlist, `timeout_ms` ∈ [1000, 1_800_000]
4. Write `confirms` / `falsifies` RegExp arrays (first match wins)
5. Run `bun test src/services/cav/pev/__tests__/canonicalTests.test.ts` — the Property 4 invariant tests will validate your entry automatically

## Stop Conditions

The runner stops when any of these fire:
- **all-resolved**: no `open` hypotheses remain
- **budget-cap-hit**: maxRounds / maxToolCalls / maxTokens / maxWallClock exceeded
- **stall-guard-hit**: 2 consecutive rounds where all agents observe-only
- **parse-storm**: ≥50% of agents fail to parse in a single round
- **user-abort**: Esc pressed

## Persistence

Each session writes `<sessionDir>/<sessionId>.pev.json` — a single JSON file containing the full audit trail (hypotheses, evidence, per-round agent outputs, stop reason). Atomic write via tmp+rename; chmod 0o600 on POSIX.

## Testing

```bash
# Type check
bun run typecheck

# PEV unit + PBT tests
bun test src/services/cav/pev/__tests__/

# Command-layer tests
bun test src/commands/ccb-pev/__tests__/

# Full CAV regression (includes PEV)
bun test src/services/cav/
```

## Key Design Decisions

- **Zero modification** to existing `dispatcher.ts`, `providers.ts`, `recorder.ts`, `extractor.ts`, `analyzer.ts`, `ReverseCliTool` — PEV is purely additive.
- **Ledger is process-owned** (not model memory) — survives attention collapse at round 5+.
- **Agents cannot fabricate tool calls** — only `CANONICAL_TESTS` whitelist ids are accepted.
- **Verdict is regex-only** — no LLM judge; deterministic and auditable.
- **Stale cascade is single-direction** — parent falsify → descendants stale; never upward.
- **Parser is 3-layer fault-tolerant** — strict JSON → lenient repair → single retry.
